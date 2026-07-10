import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { Mppx, tempo } from 'mppx/hono'
import { isAddress } from 'viem'
import {
  BUY_IN_CHIPS, BUY_IN_USD, CHIP_SCALE, JOIN_WINDOW_MS, PATH_USD, SERVER_URL, TABLE_SEATS, formatUsd,
} from '../config.js'
import { runAgent } from '../agents/index.js'
import type { TableEvent } from './table.js'
import { HttpError, Table } from './table.js'
import { BettingBook } from './bets.js'
import type { Wallet } from '../payments/wallet.js'

export type TableAppContext = {
  app: Hono
  getRoom: (id: string) => Room | undefined
}

export type Room = {
  id: string
  name: string
  table: Table
  demoRunning: boolean
  sseListeners: Set<(e: TableEvent) => void>
  fillTimer: ReturnType<typeof setTimeout> | null
  createdAt: number
}

const AGENT_NAMES = ['ace-bot', 'river-rat', 'bluff-machine', 'tilt-proof'] as const
const ROOM_ID_RE = /^[a-z0-9-]{1,24}$/
const MAX_ROOMS = 20

export function createTableApp(treasury: Wallet): TableAppContext {
  const rooms = new Map<string, Room>()

  // Fresh tables per room; SSE fan-out and bet settlement live on the room so
  // spectators keep streaming across reset/start table swaps.
  const attachTable = (room: Room, targetSeats?: number): Table => {
    const t = new Table((to, baseUnits) => treasury.send(to, baseUnits), targetSeats)
    t.subscribe((e) => {
      for (const fn of room.sseListeners) fn(e)
      if (e.type === 'settled') void bets.resolve(room.id, t.payouts)
    })
    return t
  }

  const createRoom = (id: string, name: string): Room => {
    const room: Room = {
      id,
      name,
      table: null as unknown as Table,
      demoRunning: false,
      sseListeners: new Set(),
      fillTimer: null,
      createdAt: Date.now(),
    }
    room.table = attachTable(room)
    rooms.set(id, room)
    return room
  }

  const swapTable = (room: Room, targetSeats?: number): void => {
    if (room.fillTimer) clearTimeout(room.fillTimer)
    room.fillTimer = null
    room.table.dispose()
    void bets.refundOpen(room.id, 'new match')
    room.table = attachTable(room, targetSeats)
  }

  createRoom('main', 'Main table')

  const bets = new BettingBook(treasury, (roomId, type, data) => rooms.get(roomId)?.table.emitSystem(type, data))

  const getRoom = (c: Context): Room => {
    const id = c.req.query('room') || 'main'
    const room = rooms.get(id)
    if (!room) throw new HttpError(404, `Unknown room: ${id}`)
    return room
  }

  const matchLocked = (room: Room): boolean => room.demoRunning || room.table.state === 'playing'
  const bettingOpen = (room: Room): boolean =>
    (room.table.state === 'waiting' || room.table.state === 'playing') && room.table.seats.length > 0

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

  // ---- rooms ----

  app.get('/api/rooms', (c) =>
    c.json(
      [...rooms.values()].map((room) => ({
        id: room.id,
        name: room.name,
        state: room.table.state,
        players: room.table.seats.map((s) => s.id),
        targetSeats: room.table.targetSeats,
        openSeats: room.table.state === 'waiting' ? Math.max(0, room.table.targetSeats - room.table.seats.length) : 0,
        handNumber: room.table.handNumber,
        hideHoleCards: room.table.hideHoleCards,
      })),
    ),
  )

  app.post('/api/rooms', async (c) => {
    // Lazy GC: drop settled/idle non-main rooms older than an hour.
    for (const [id, room] of rooms) {
      if (id === 'main') continue
      const idle = room.table.state === 'settled' || (room.table.state === 'waiting' && room.table.seats.length === 0)
      if (idle && Date.now() - room.createdAt > 60 * 60 * 1000) {
        room.table.dispose()
        rooms.delete(id)
      }
    }
    if (rooms.size >= MAX_ROOMS) throw new HttpError(429, 'Room limit reached — try again later')
    const body = await c.req.json().catch(() => ({}))
    const requestedId = typeof body.id === 'string' ? body.id.toLowerCase() : ''
    const id = ROOM_ID_RE.test(requestedId) && !rooms.has(requestedId)
      ? requestedId
      : `r-${randomBytes(3).toString('hex')}`
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : `Table ${id}`
    const room = createRoom(id, name)
    return c.json({ id: room.id, name: room.name })
  })

  // ---- table (all routes take ?room=, defaulting to main) ----

  app.get('/api/table', (c) => {
    const room = getRoom(c)
    const token = c.req.header('x-player-token')
    const seat = token ? room.table.seatByToken(token) : undefined
    return c.json({ room: room.id, ...room.table.view(seat) })
  })

  app.post('/api/table/start', async (c) => {
    const room = getRoom(c)
    if (matchLocked(room)) throw new HttpError(409, 'A match is already running')
    const body = await c.req.json().catch(() => ({}))
    const seatCount = Math.max(2, Math.min(Number(body.seats ?? TABLE_SEATS) || TABLE_SEATS, 4))
    const houseSeats = Math.max(0, Math.min(Number(body.houseSeats ?? seatCount), seatCount))
    if (room.table.state !== 'waiting' || room.table.seats.length > 0 || room.table.targetSeats !== seatCount) {
      swapTable(room, seatCount)
    }
    const openSeats = seatCount - houseSeats
    room.table.hideHoleCards = openSeats > 0
    const names = AGENT_NAMES.slice(0, houseSeats)
    room.demoRunning = names.length > 0
    room.table.emitSystem('demo_started', {
      players: names,
      openSeats,
      room: room.id,
      serverUrl: SERVER_URL,
    })

    if (names.length) {
      void Promise.allSettled(names.map((name) => runAgent(name, { serverUrl: SERVER_URL, room: room.id })))
        .then((results) => {
          room.table.emitSystem('demo_finished', {
            results: results.map((result, index) => (
              result.status === 'fulfilled'
                ? result.value
                : { playerId: names[index], error: result.reason instanceof Error ? result.reason.message : String(result.reason) }
            )),
          })
        })
        .catch((error) => {
          room.table.emitSystem('demo_error', { error: error instanceof Error ? error.message : String(error) })
        })
        .finally(() => {
          room.demoRunning = false
        })
    }

    // Open seats wait for outside agents; house bots fill whatever is left
    // when the join window closes so the match always starts.
    if (openSeats > 0) {
      const startedTable = room.table
      room.fillTimer = setTimeout(() => {
        room.fillTimer = null
        if (room.table !== startedTable || startedTable.state !== 'waiting') return
        const used = new Set(startedTable.seats.map((s) => s.id))
        const fillers = AGENT_NAMES.filter((n) => !used.has(n)).slice(
          0,
          Math.max(0, startedTable.targetSeats - startedTable.seats.length),
        )
        if (!fillers.length) return
        startedTable.emitSystem('house_filling', { players: fillers })
        void Promise.allSettled(fillers.map((name) => runAgent(name, { serverUrl: SERVER_URL, room: room.id })))
      }, JOIN_WINDOW_MS)
    }

    return c.json({ ok: true, players: names, openSeats, room: room.id })
  })

  app.post('/api/table/reset', (c) => {
    const room = getRoom(c)
    if (matchLocked(room)) throw new HttpError(409, 'A match is already running')
    swapTable(room)
    return new Response(null, { status: 204 })
  })

  app.post(
    '/api/table/join',
    // Validate for free BEFORE the 402 charge — a doomed join (full table,
    // match running, taken name) must be rejected while it costs nothing.
    async (c, next) => {
      const room = getRoom(c)
      const body = await c.req.json().catch(() => ({}))
      const { playerId, address } = body as { playerId?: string; address?: string }
      if (!playerId || typeof playerId !== 'string' || playerId.length > 32) {
        throw new HttpError(400, 'playerId (string, <=32 chars) required')
      }
      if (!address || !isAddress(address)) {
        throw new HttpError(400, 'address (payout wallet) required')
      }
      if (room.table.state !== 'waiting') throw new HttpError(409, 'Table is not accepting players')
      if (room.table.seats.length >= room.table.targetSeats) throw new HttpError(409, 'Table is full')
      if (room.table.seats.some((s) => s.id === playerId)) throw new HttpError(409, `Player id taken: ${playerId}`)
      await next()
    },
    mppx.charge({
      amount: String(BUY_IN_USD),
      description: `x402-poker buy-in (${formatUsd(BUY_IN_USD * 1e6)})`,
    }),
    async (c) => {
      const room = getRoom(c)
      const body = (await c.req.json()) as { playerId: string; address: `0x${string}` }
      try {
        const seat = room.table.join(body.playerId, body.address, lastReceipt)
        return c.json({ token: seat.token, seat: { id: seat.id, chips: seat.chips }, room: room.id })
      } catch (error) {
        // The buy-in already settled; a race (seat taken mid-payment) refunds it.
        await treasury.send(body.address as `0x${string}`, BigInt(BUY_IN_CHIPS)).catch(console.error)
        throw error instanceof HttpError
          ? new HttpError(error.status, `${error.message} — buy-in refunded`)
          : error
      }
    },
  )

  app.post('/api/table/act', async (c) => {
    const room = getRoom(c)
    const token = c.req.header('x-player-token')
    if (!token) throw new HttpError(401, 'x-player-token header required')
    const action = await c.req.json()
    room.table.act(token, action)
    return c.json({ ok: true })
  })

  app.post('/api/table/say', async (c) => {
    const room = getRoom(c)
    const token = c.req.header('x-player-token')
    if (!token) throw new HttpError(401, 'x-player-token header required')
    const { say, thinking } = await c.req.json()
    room.table.speak(token, say, thinking)
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

  const betContext = (room: Room) => ({
    seatedIds: room.table.seats.map((s) => s.id),
    open: bettingOpen(room),
    multiplier: room.table.targetSeats,
  })

  app.post('/api/bets/place', async (c) => {
    const room = getRoom(c)
    const body = await c.req.json().catch(() => ({}))
    const { spectatorId, agentId, amount } = body as { spectatorId?: string; agentId?: string; amount?: number }
    if (typeof spectatorId !== 'string' || typeof agentId !== 'string' || typeof amount !== 'number') {
      throw new HttpError(400, 'spectatorId, agentId, amount required')
    }
    const bet = await bets.place(spectatorId, room.id, agentId, Math.round(amount * CHIP_SCALE), betContext(room))
    return c.json({ bet, balance: await bets.balance(spectatorId) })
  })

  app.post('/api/bets/withdraw', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const { spectatorId, address } = body as { spectatorId?: string; address?: string }
    if (typeof spectatorId !== 'string' || typeof address !== 'string') {
      throw new HttpError(400, 'spectatorId and address required')
    }
    return c.json(await bets.withdraw(spectatorId, address))
  })

  // Bet with your own wallet over MPP: any x402-capable client pays the 402
  // (stake settles to the treasury) and names where winnings should go.
  // Middleware amounts are fixed per route, so bets come in tiers. The bet is
  // validated BEFORE the charge so a doomed bet is rejected while it is still
  // free; the rare post-payment race refunds the stake.
  for (const tier of [1, 5, 20] as const) {
    app.post(
      `/api/bets/place-mpp/${tier}`,
      async (c, next) => {
        const room = getRoom(c)
        const body = await c.req.json().catch(() => ({}))
        const { agentId, payoutAddress } = body as { agentId?: string; payoutAddress?: string }
        if (typeof agentId !== 'string' || typeof payoutAddress !== 'string' || !isAddress(payoutAddress)) {
          throw new HttpError(400, 'agentId and payoutAddress (where winnings go) required')
        }
        const ctx = betContext(room)
        if (!ctx.open) throw new HttpError(409, 'Betting is closed for this match')
        if (!ctx.seatedIds.includes(agentId)) throw new HttpError(400, 'Unknown player')
        await next()
      },
      mppx.charge({ amount: String(tier), description: `x402-poker spectator bet ($${tier})` }),
      async (c) => {
        const room = getRoom(c)
        const body = (await c.req.json()) as { agentId: string; payoutAddress: string }
        try {
          const bet = bets.placeExternal(room.id, body.agentId, tier * CHIP_SCALE, body.payoutAddress, lastReceipt, betContext(room))
          return c.json({ bet })
        } catch (error) {
          // The 402 already settled; return the stake before failing.
          await treasury.send(body.payoutAddress as `0x${string}`, BigInt(tier * CHIP_SCALE)).catch(console.error)
          throw error instanceof HttpError
            ? new HttpError(error.status, `${error.message} — stake refunded`)
            : error
        }
      },
    )
  }

  app.get('/api/bets/state', async (c) => {
    const room = getRoom(c)
    const spectatorId = c.req.query('spectatorId') ?? undefined
    const { pools, myBets } = bets.state(room.id, spectatorId)
    const balance = spectatorId ? await bets.balance(spectatorId).catch(() => null) : null
    return c.json({
      open: bettingOpen(room),
      multiplier: room.table.targetSeats,
      pools,
      myBets,
      balance,
    })
  })

  app.get('/api/table/log', (c) => {
    const room = getRoom(c)
    const token = c.req.header('x-player-token')
    const seat = token ? room.table.seatByToken(token) : undefined
    return c.json(seat ? filterAgentEvents(room.table.events) : room.table.events)
  })

  app.get('/api/table/events', (c) => {
    const room = getRoom(c)
    return streamSSE(c, async (stream) => {
      // Flush headers right away so EventSource fires onopen even when the
      // event log is still empty (piped streams only send headers on first write).
      await stream.write(': connected\n\n')
      for (const e of room.table.events) {
        await stream.writeSSE({ data: JSON.stringify(e), id: String(e.seq) })
      }
      let open = true
      const listener = (e: TableEvent) => {
        void stream.writeSSE({ data: JSON.stringify(e), id: String(e.seq) })
      }
      room.sseListeners.add(listener)
      stream.onAbort(() => {
        open = false
        room.sseListeners.delete(listener)
      })
      while (open) {
        await new Promise((r) => setTimeout(r, 15_000))
        if (open) await stream.write(': keepalive\n\n').catch(() => undefined)
      }
    })
  })

  return { app, getRoom: (id: string) => rooms.get(id) }
}

function filterAgentEvents(events: TableEvent[]): TableEvent[] {
  return events.filter((event) => event.type !== 'thought')
}
