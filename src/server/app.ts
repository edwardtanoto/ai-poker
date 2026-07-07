import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { Mppx, tempo } from 'mppx/hono'
import { isAddress } from 'viem'
import { BUY_IN_USD, PATH_USD, SERVER_URL, TABLE_SEATS, formatUsd } from '../config.js'
import { runAgent } from '../agents/index.js'
import type { TableEvent } from './table.js'
import { HttpError, Table } from './table.js'
import type { Wallet } from '../payments/wallet.js'

export type TableAppContext = {
  app: Hono
  getTable: () => Table
  resetTable: () => Table
}

const AGENT_NAMES = ['ace-bot', 'river-rat', 'bluff-machine', 'tilt-proof'] as const

export function createTableApp(treasury: Wallet): TableAppContext {
  let table = new Table((to, baseUnits) => treasury.send(to, baseUnits))
  let demoRunning = false

  const resetTable = () => {
    if (demoRunning) throw new HttpError(409, 'A match is already running')
    table = new Table((to, baseUnits) => treasury.send(to, baseUnits))
    return table
  }

  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        testnet: true,
        currency: PATH_USD,
        recipient: treasury.address,
      }),
    ],
    realm: 'x402-poker',
    secretKey: process.env.MPP_SECRET_KEY ?? randomBytes(32).toString('hex'),
  })

  // Receipts are attached to the response after the handler runs, so capture
  // the most recent verified payment here for the join handler to record.
  // Single-process demo joins are sequential enough for the current MVP.
  let lastReceipt: string | undefined
  mppx.onPaymentSuccess(({ receipt }) => {
    lastReceipt = JSON.stringify(receipt)
  })

  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 409)
    console.error('[server]', err)
    return c.json({ error: 'Internal error' }, 500)
  })

  app.get('/api/health', (c) =>
    c.json({ ok: true, treasury: treasury.address, buyIn: `$${BUY_IN_USD}`, seats: TABLE_SEATS }),
  )

  app.get('/api/table', (c) => {
    const token = c.req.header('x-player-token')
    const seat = token ? table.seatByToken(token) : undefined
    return c.json(table.view(seat))
  })

  app.post('/api/table/start', async (c) => {
    if (demoRunning) throw new HttpError(409, 'A match is already running')
    if (table.state !== 'waiting' || table.seats.length > 0) {
      table = new Table((to, baseUnits) => treasury.send(to, baseUnits))
    }

    const body = await c.req.json().catch(() => ({}))
    const seatCount = Math.max(2, Math.min(Number(body.seats ?? TABLE_SEATS) || TABLE_SEATS, AGENT_NAMES.length))
    const names = AGENT_NAMES.slice(0, seatCount)
    demoRunning = true
    table.emitSystem('demo_started', { players: names, serverUrl: SERVER_URL })

    void Promise.allSettled(names.map((name) => runAgent(name, { serverUrl: SERVER_URL })))
      .then((results) => {
        table.emitSystem('demo_finished', {
          results: results.map((result, index) => (
            result.status === 'fulfilled'
              ? result.value
              : { playerId: names[index], error: result.reason instanceof Error ? result.reason.message : String(result.reason) }
          )),
        })
      })
      .catch((error) => {
        table.emitSystem('demo_error', { error: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        demoRunning = false
      })

    return c.json({ ok: true, players: names })
  })

  app.post('/api/table/reset', () => {
    resetTable()
    return new Response(null, { status: 204 })
  })

  app.post(
    '/api/table/join',
    mppx.charge({
      amount: String(BUY_IN_USD),
      description: `x402-poker buy-in (${formatUsd(BUY_IN_USD * 1e6)})`,
    }),
    async (c) => {
      const body = await c.req.json().catch(() => ({}))
      const { playerId, address } = body as { playerId?: string; address?: string }
      if (!playerId || typeof playerId !== 'string' || playerId.length > 32) {
        throw new HttpError(400, 'playerId (string, <=32 chars) required')
      }
      if (!address || !isAddress(address)) {
        throw new HttpError(400, 'address (payout wallet) required')
      }
      const seat = table.join(playerId, address, lastReceipt)
      return c.json({ token: seat.token, seat: { id: seat.id, chips: seat.chips } })
    },
  )

  app.post('/api/table/act', async (c) => {
    const token = c.req.header('x-player-token')
    if (!token) throw new HttpError(401, 'x-player-token header required')
    const action = await c.req.json()
    table.act(token, action)
    return c.json({ ok: true })
  })

  app.post('/api/table/say', async (c) => {
    const token = c.req.header('x-player-token')
    if (!token) throw new HttpError(401, 'x-player-token header required')
    const { say, thinking } = await c.req.json()
    table.speak(token, say, thinking)
    return c.json({ ok: true })
  })

  app.get('/api/table/log', (c) => {
    const token = c.req.header('x-player-token')
    const seat = token ? table.seatByToken(token) : undefined
    return c.json(seat ? filterAgentEvents(table.events) : table.events)
  })

  app.get('/api/table/events', (c) =>
    streamSSE(c, async (stream) => {
      for (const e of table.events) {
        await stream.writeSSE({ data: JSON.stringify(e), id: String(e.seq) })
      }
      let open = true
      const unsubscribe = table.subscribe((e) => {
        void stream.writeSSE({ data: JSON.stringify(e), id: String(e.seq) })
      })
      stream.onAbort(() => {
        open = false
        unsubscribe()
      })
      while (open) await new Promise((r) => setTimeout(r, 15_000))
    }),
  )

  return { app, getTable: () => table, resetTable }
}

function filterAgentEvents(events: TableEvent[]): TableEvent[] {
  return events.filter((event) => event.type !== 'thought')
}
