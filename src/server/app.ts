import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { Mppx, tempo } from 'mppx/hono'
import { isAddress } from 'viem'
import { BUY_IN_USD, CHIP_SCALE, PATH_USD, SERVER_URL, TABLE_SEATS, formatUsd } from '../config.js'
import { runAgent } from '../agents/index.js'
import type { TableEvent } from './table.js'
import { HttpError, Table } from './table.js'
import { BettingBook } from './bets.js'
import type { Wallet } from '../payments/wallet.js'

export type TableAppContext = {
  app: Hono
  getTable: () => Table
  resetTable: () => Table
}

const AGENT_NAMES = ['ace-bot', 'river-rat', 'bluff-machine', 'tilt-proof'] as const

export function createTableApp(treasury: Wallet): TableAppContext {
  // SSE fan-out lives outside the Table so connected spectators keep
  // receiving events after reset/start swaps in a fresh Table instance.
  const sseListeners = new Set<(e: TableEvent) => void>()
  const newTable = (targetSeats?: number): Table => {
    const t = new Table((to, baseUnits) => treasury.send(to, baseUnits), targetSeats)
    t.subscribe((e) => {
      for (const fn of sseListeners) fn(e)
      // Settle spectator bets once the match result is final.
      if (e.type === 'settled') void bets.resolve(t.payouts)
    })
    return t
  }

  let table = newTable()
  let demoRunning = false
  const bets = new BettingBook(treasury, (type, data) => table.emitSystem(type, data))

  const resetTable = () => {
    if (demoRunning) throw new HttpError(409, 'A match is already running')
    void bets.refundOpen('match reset')
    table = newTable()
    return table
  }

  const bettingOpen = () => (table.state === 'waiting' || table.state === 'playing') && table.seats.length > 0

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
    const body = await c.req.json().catch(() => ({}))
    const seatCount = Math.max(2, Math.min(Number(body.seats ?? TABLE_SEATS) || TABLE_SEATS, AGENT_NAMES.length))
    if (table.state !== 'waiting' || table.seats.length > 0 || table.targetSeats !== seatCount) {
      void bets.refundOpen('new match')
      table = newTable(seatCount)
    }
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

  // ---- spectator betting (server-custodial testnet wallets) ----

  app.post('/api/bets/session', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const session = await bets.session(typeof body.spectatorId === 'string' ? body.spectatorId : undefined)
    return c.json(session)
  })

  app.post('/api/bets/topup', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.spectatorId !== 'string') throw new HttpError(400, 'spectatorId required')
    return c.json(await bets.topup(body.spectatorId))
  })

  app.post('/api/bets/place', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const { spectatorId, agentId, amount } = body as { spectatorId?: string; agentId?: string; amount?: number }
    if (typeof spectatorId !== 'string' || typeof agentId !== 'string' || typeof amount !== 'number') {
      throw new HttpError(400, 'spectatorId, agentId, amount required')
    }
    const bet = await bets.place(spectatorId, agentId, Math.round(amount * CHIP_SCALE), {
      seatedIds: table.seats.map((s) => s.id),
      open: bettingOpen(),
      multiplier: table.targetSeats,
    })
    return c.json({ bet, balance: await bets.balance(spectatorId) })
  })

  app.get('/api/bets/state', async (c) => {
    const spectatorId = c.req.query('spectatorId') ?? undefined
    const { pools, myBets } = bets.state(spectatorId)
    const balance = spectatorId ? await bets.balance(spectatorId).catch(() => null) : null
    return c.json({
      open: bettingOpen(),
      multiplier: table.targetSeats,
      pools,
      myBets,
      balance,
    })
  })

  app.get('/api/table/log', (c) => {
    const token = c.req.header('x-player-token')
    const seat = token ? table.seatByToken(token) : undefined
    return c.json(seat ? filterAgentEvents(table.events) : table.events)
  })

  app.get('/api/table/events', (c) =>
    streamSSE(c, async (stream) => {
      // Flush headers right away so EventSource fires onopen even when the
      // event log is still empty (piped streams only send headers on first write).
      await stream.write(': connected\n\n')
      for (const e of table.events) {
        await stream.writeSSE({ data: JSON.stringify(e), id: String(e.seq) })
      }
      let open = true
      const listener = (e: TableEvent) => {
        void stream.writeSSE({ data: JSON.stringify(e), id: String(e.seq) })
      }
      sseListeners.add(listener)
      stream.onAbort(() => {
        open = false
        sseListeners.delete(listener)
      })
      while (open) {
        await new Promise((r) => setTimeout(r, 15_000))
        if (open) await stream.write(': keepalive\n\n').catch(() => undefined)
      }
    }),
  )

  return { app, getTable: () => table, resetTable }
}

function filterAgentEvents(events: TableEvent[]): TableEvent[] {
  return events.filter((event) => event.type !== 'thought')
}
