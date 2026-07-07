import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { Mppx, tempo } from 'mppx/hono'
import { isAddress } from 'viem'
import { BUY_IN_USD, PATH_USD, SERVER_PORT, TABLE_SEATS, formatUsd } from '../config.js'
import { openWallet } from '../payments/wallet.js'
import { HttpError, Table } from './table.js'

const treasury = await openWallet('treasury', '.wallets/treasury.json')
console.log(`[server] treasury: ${treasury.address}`)

const table = new Table((to, baseUnits) => treasury.send(to, baseUnits))

// MPP payment handler — buy-ins are Tempo testnet pathUSD charges settled
// on-chain to the treasury before the join handler ever runs.
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
// (Single table, joins are sequential — good enough for the MVP.)
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

/**
 * Join the table. Gated by an MPP 402 challenge: the request only reaches
 * this handler after the buy-in charge has been verified on-chain.
 */
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
      throw new HttpError(400, 'playerId (string, ≤32 chars) required')
    }
    if (!address || !isAddress(address)) {
      throw new HttpError(400, 'address (payout wallet) required')
    }
    const seat = table.join(playerId, address, lastReceipt)
    return c.json({ token: seat.token, seat: { id: seat.id, chips: seat.chips } })
  },
)

/** Table state. With a valid x-player-token header, includes private cards + legal actions. */
app.get('/api/table', (c) => {
  const token = c.req.header('x-player-token')
  const seat = token ? table.seatByToken(token) : undefined
  return c.json(table.view(seat))
})

/** Submit an action for the seat owning the token. */
app.post('/api/table/act', async (c) => {
  const token = c.req.header('x-player-token')
  if (!token) throw new HttpError(401, 'x-player-token header required')
  const action = await c.req.json()
  table.act(token, action)
  return c.json({ ok: true })
})

/** Table talk + thinking from an agent. `say` is public; `thinking` is spectator color. */
app.post('/api/table/say', async (c) => {
  const token = c.req.header('x-player-token')
  if (!token) throw new HttpError(401, 'x-player-token header required')
  const { say, thinking } = await c.req.json()
  table.speak(token, say, thinking)
  return c.json({ ok: true })
})

/** Full event log (hand history, payments, payouts). */
app.get('/api/table/log', (c) => c.json(table.events))

/** Server-sent events stream for spectators. */
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

app.get('/', (c) => c.html(readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')))

serve({ fetch: app.fetch, port: SERVER_PORT }, (info) => {
  console.log(`[server] x402-poker table listening on http://localhost:${info.port}`)
  console.log(`[server] buy-in $${BUY_IN_USD} pathUSD via MPP · ${TABLE_SEATS} seats`)
})
