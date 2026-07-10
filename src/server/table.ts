import { randomBytes } from 'node:crypto'
import type { Address } from 'viem'
import {
  ACT_TIMEOUT_MS, BIG_BLIND, BUY_IN_CHIPS, MAX_HANDS, SMALL_BLIND, TABLE_SEATS, formatUsd,
} from '../config.js'
import { Hand, type LegalActions } from '../engine/hand.js'
import type { Action, Card, HandResult } from '../engine/types.js'

export type Seat = {
  id: string
  address: Address
  token: string
  chips: number
  buyInReceipt?: string
}

export type TableEvent = {
  seq: number
  time: number
  type: string
  data: Record<string, unknown>
}

export type Payout = { playerId: string; address: Address; chips: number; txHash?: string; error?: string }

export type PayoutFn = (to: Address, baseUnits: bigint) => Promise<`0x${string}`>

export class Table {
  state: 'waiting' | 'playing' | 'settling' | 'settled' = 'waiting'
  seats: Seat[] = []
  hand: Hand | null = null
  handNumber = 0
  dealerIndex = 0
  history: HandResult[] = []
  payouts: Payout[] = []
  events: TableEvent[] = []
  /** Blank spectator hole cards while a hand is live (rooms open to outside agents). */
  hideHoleCards = false

  private seq = 0
  private logCursor = 0
  private listeners = new Set<(e: TableEvent) => void>()
  private turnTimer: ReturnType<typeof setTimeout> | null = null
  private readonly payoutFn: PayoutFn
  readonly targetSeats: number
  readonly actTimeoutMs: number

  constructor(payoutFn: PayoutFn, targetSeats: number = TABLE_SEATS, actTimeoutMs: number = ACT_TIMEOUT_MS) {
    this.payoutFn = payoutFn
    this.targetSeats = Math.max(2, Math.min(Math.floor(targetSeats) || 2, 4))
    this.actTimeoutMs = actTimeoutMs
  }

  /** Stop timers when the table is replaced so an orphan can't keep playing. */
  dispose(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = null
    this.listeners.clear()
  }

  subscribe(fn: (e: TableEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emitSystem(type: string, data: Record<string, unknown>): void {
    this.emit(type, data)
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const event: TableEvent = { seq: ++this.seq, time: Date.now(), type, data }
    this.events.push(event)
    if (this.events.length > 2000) this.events.shift()
    for (const fn of this.listeners) fn(event)
  }

  join(playerId: string, address: Address, buyInReceipt?: string): Seat {
    if (this.state !== 'waiting') throw new HttpError(409, 'Table is not accepting players')
    if (this.seats.some((s) => s.id === playerId)) throw new HttpError(409, `Player id taken: ${playerId}`)
    const seat: Seat = {
      id: playerId,
      address,
      token: randomBytes(24).toString('hex'),
      chips: BUY_IN_CHIPS,
      buyInReceipt,
    }
    this.seats.push(seat)
    this.emit('player_joined', {
      playerId, address, buyIn: formatUsd(BUY_IN_CHIPS), seats: this.seats.length, needed: this.targetSeats,
    })
    if (this.seats.length >= this.targetSeats) this.startHand()
    return seat
  }

  seatByToken(token: string): Seat | undefined {
    return this.seats.find((s) => s.token === token)
  }

  /** Broadcast table talk (public) and/or the agent's thinking (spectator-only flavor). */
  speak(token: string, say?: string, thinking?: string): void {
    const seat = this.seatByToken(token)
    if (!seat) throw new HttpError(401, 'Unknown player token')
    if (thinking) this.emit('thought', { playerId: seat.id, thinking: String(thinking).slice(0, 2000) })
    if (say) this.emit('chat', { playerId: seat.id, say: String(say).slice(0, 200) })
  }

  act(token: string, action: Action): void {
    const seat = this.seatByToken(token)
    if (!seat) throw new HttpError(401, 'Unknown player token')
    if (this.state !== 'playing' || !this.hand) throw new HttpError(409, 'No hand in progress')
    if (this.hand.currentPlayerId !== seat.id) throw new HttpError(409, 'Not your turn')
    this.hand.act(seat.id, action)
    this.flushHandLog()
    if (this.hand.isComplete) this.finishHand()
    else this.armTurnTimer()
  }

  /**
   * A stalled or dead player must not freeze the table: when the act timeout
   * elapses, the current player checks if legal, otherwise folds.
   */
  private armTurnTimer(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = null
    if (!this.actTimeoutMs || this.state !== 'playing' || !this.hand) return
    const playerId = this.hand.currentPlayerId
    if (!playerId) return
    this.turnTimer = setTimeout(() => this.autoAct(playerId), this.actTimeoutMs)
  }

  private autoAct(playerId: string): void {
    if (this.state !== 'playing' || !this.hand || this.hand.currentPlayerId !== playerId) return
    const legal = this.hand.legalActions()
    const action: Action = legal?.canCheck ? { type: 'check' } : { type: 'fold' }
    this.emit('timeout', { playerId, action: action.type })
    this.hand.act(playerId, action)
    this.flushHandLog()
    if (this.hand.isComplete) this.finishHand()
    else this.armTurnTimer()
  }

  /** Spectators see the whole table; pass a seat for the private agent API view. */
  view(seat?: Seat) {
    const hand = this.hand
    const agentView = Boolean(seat)
    return {
      state: this.state,
      handNumber: this.handNumber,
      maxHands: MAX_HANDS,
      targetSeats: this.targetSeats,
      blinds: { small: SMALL_BLIND, big: BIG_BLIND },
      seats: this.seats.map((s) => ({
        id: s.id,
        address: s.address,
        chips: this.state === 'playing' && hand
          ? hand.players.find((p) => p.id === s.id)?.stack ?? s.chips
          : s.chips,
      })),
      hand: hand && this.state === 'playing'
        ? {
            street: hand.street,
            board: hand.board,
            pot: hand.pot,
            currentPlayerId: hand.currentPlayerId,
            players: hand.players.map((p) => ({
              id: p.id,
              status: p.status,
              streetBet: p.streetBet,
              stack: p.stack,
              holeCards: agentView || this.hideHoleCards ? [] : p.holeCards,
            })),
          }
        : null,
      you: seat && hand && this.state === 'playing'
        ? {
            id: seat.id,
            holeCards: hand.players.find((p) => p.id === seat.id)?.holeCards ?? [],
            legalActions: hand.currentPlayerId === seat.id ? hand.legalActions() : null,
          }
        : seat
          ? { id: seat.id, holeCards: [] as Card[], legalActions: null as LegalActions | null }
          : undefined,
      payouts: this.payouts,
    }
  }

  private startHand(): void {
    this.state = 'playing'
    this.handNumber += 1
    // Rotate the button past busted seats
    if (this.handNumber > 1) {
      do {
        this.dealerIndex = (this.dealerIndex + 1) % this.seats.length
      } while (this.seats[this.dealerIndex]!.chips <= 0)
    }
    this.hand = new Hand(
      this.seats.map((s) => ({ id: s.id, stack: s.chips })),
      this.dealerIndex,
      this.handNumber,
      { smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND },
    )
    this.logCursor = 0
    this.flushHandLog()
    if (this.hand.isComplete) this.finishHand()
    else this.armTurnTimer()
  }

  private flushHandLog(): void {
    if (!this.hand) return
    while (this.logCursor < this.hand.log.length) {
      const entry = this.hand.log[this.logCursor++]!
      this.emit(entry.kind, entry as unknown as Record<string, unknown>)
    }
  }

  private finishHand(): void {
    const hand = this.hand!
    for (const seat of this.seats) {
      seat.chips = hand.players.find((p) => p.id === seat.id)!.stack
    }
    this.history.push(hand.result!)
    this.hand = null

    const alive = this.seats.filter((s) => s.chips > 0)
    if (alive.length <= 1 || this.handNumber >= MAX_HANDS) {
      void this.settle()
    } else {
      this.startHand()
    }
  }

  private async settle(): Promise<void> {
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = null
    this.state = 'settling'
    this.emit('settling', {
      stacks: Object.fromEntries(this.seats.map((s) => [s.id, formatUsd(s.chips)])),
    })
    for (const seat of this.seats) {
      if (seat.chips <= 0) continue
      const payout: Payout = { playerId: seat.id, address: seat.address, chips: seat.chips }
      try {
        payout.txHash = await this.payoutFn(seat.address, BigInt(seat.chips))
        this.emit('payout', {
          playerId: seat.id, address: seat.address, amount: formatUsd(seat.chips), txHash: payout.txHash,
        })
      } catch (error) {
        payout.error = error instanceof Error ? error.message : String(error)
        this.emit('payout_failed', { playerId: seat.id, error: payout.error })
      }
      this.payouts.push(payout)
    }
    this.state = 'settled'
    this.emit('settled', { hands: this.handNumber, payouts: this.payouts.length })
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}
