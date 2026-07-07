import { createDeck, shuffle } from './cards.js'
import { evaluate } from './evaluator.js'
import type {
  Action, Card, HandConfig, HandResult, LogEvent, PlayerState, Street,
} from './types.js'

export type LegalActions = {
  playerId: string
  canFold: boolean
  canCheck: boolean
  canCall: boolean
  callAmount: number
  canRaise: boolean
  /** Total street commitment a raise must reach at minimum. */
  minRaiseTo: number
  /** Raising to more than this is capped at all-in. */
  maxRaiseTo: number
}

/**
 * A single hand of no-limit Texas Hold'em.
 *
 * Drive it with `legalActions()` + `act()` until `isComplete`, then read
 * `result`. Stacks on the passed-in player objects are mutated as the hand
 * plays out (blinds, bets, winnings).
 */
export class Hand {
  readonly players: PlayerState[]
  readonly board: Card[] = []
  readonly log: LogEvent[] = []
  street: Street = 'preflop'
  pot = 0
  result: HandResult | null = null

  private deck: Card[]
  private currentBet = 0
  private lastRaiseSize = 0
  private toActIndex = 0
  private readonly dealerIndex: number
  private readonly config: HandConfig
  private readonly handNumber: number

  constructor(
    players: { id: string; stack: number }[],
    dealerIndex: number,
    handNumber: number,
    config: HandConfig,
  ) {
    if (players.length < 2) throw new Error('Need at least 2 players')
    this.config = config
    this.handNumber = handNumber
    this.dealerIndex = dealerIndex
    this.players = players.map((p) => ({
      id: p.id,
      stack: p.stack,
      status: p.stack > 0 ? 'active' : 'out',
      holeCards: [],
      streetBet: 0,
      totalBet: 0,
      hasActedThisRound: false,
    }))
    this.deck = shuffle(createDeck(), config.random ?? Math.random)

    this.log.push({
      kind: 'hand_start',
      handNumber,
      dealerId: this.players[dealerIndex]!.id,
      stacks: Object.fromEntries(this.players.map((p) => [p.id, p.stack])),
    })

    this.postBlinds()
    this.dealHoleCards()
    this.toActIndex = this.firstToAct('preflop')
    if (!this.settleIfNoContest() && this.players.every((p) => p.status !== 'active')) {
      // Everyone is all-in from the blinds — run the board out
      this.nextStreet()
    }
  }

  get isComplete(): boolean {
    return this.result !== null
  }

  get currentPlayerId(): string | null {
    if (this.isComplete) return null
    return this.players[this.toActIndex]!.id
  }

  legalActions(): LegalActions | null {
    if (this.isComplete) return null
    const p = this.players[this.toActIndex]!
    const callAmount = Math.min(this.currentBet - p.streetBet, p.stack)
    const minRaiseTo = this.currentBet + Math.max(this.lastRaiseSize, this.config.bigBlind)
    const maxRaiseTo = p.streetBet + p.stack
    return {
      playerId: p.id,
      canFold: callAmount > 0,
      canCheck: callAmount === 0,
      canCall: callAmount > 0,
      callAmount,
      canRaise: maxRaiseTo > this.currentBet,
      minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
      maxRaiseTo,
    }
  }

  act(playerId: string, action: Action): void {
    if (this.isComplete) throw new Error('Hand is complete')
    const p = this.players[this.toActIndex]!
    if (p.id !== playerId) throw new Error(`Not ${playerId}'s turn (${p.id} to act)`)
    const legal = this.legalActions()!

    let type = action.type
    let committed = 0

    switch (type) {
      case 'fold': {
        p.status = 'folded'
        break
      }
      case 'check': {
        if (!legal.canCheck) throw new Error('Cannot check facing a bet')
        break
      }
      case 'call': {
        if (!legal.canCall) throw new Error('Nothing to call')
        committed = this.commit(p, legal.callAmount)
        break
      }
      case 'allin': {
        committed = this.commit(p, p.stack)
        break
      }
      case 'raise': {
        const target = action.amount ?? legal.minRaiseTo
        if (!legal.canRaise) throw new Error('Cannot raise')
        const clamped = Math.max(Math.min(target, legal.maxRaiseTo), legal.minRaiseTo)
        const effective = Math.min(clamped, legal.maxRaiseTo)
        committed = this.commit(p, effective - p.streetBet)
        break
      }
    }

    if (p.stack === 0 && p.status === 'active') p.status = 'allin'
    if (p.status === 'allin' && type !== 'fold') type = p.streetBet >= this.currentBet ? type : 'allin'

    // A raise (or all-in exceeding current bet) reopens action
    if (p.streetBet > this.currentBet) {
      const raiseSize = p.streetBet - this.currentBet
      // Only a full raise resets min-raise sizing; an all-in short raise does not,
      // but for MVP we still reopen action to keep the loop simple and fair.
      if (raiseSize >= Math.max(this.lastRaiseSize, this.config.bigBlind)) {
        this.lastRaiseSize = raiseSize
      }
      this.currentBet = p.streetBet
      for (const other of this.players) {
        if (other !== p && other.status === 'active') other.hasActedThisRound = false
      }
    }

    p.hasActedThisRound = true
    this.log.push({ kind: 'action', playerId, action: type, amount: committed, street: this.street })

    if (this.settleIfNoContest()) return
    this.advance()
  }

  /** Moves chips from stack to pot; returns amount actually committed. */
  private commit(p: PlayerState, amount: number): number {
    const amt = Math.min(amount, p.stack)
    p.stack -= amt
    p.streetBet += amt
    p.totalBet += amt
    this.pot += amt
    if (p.stack === 0) p.status = 'allin'
    return amt
  }

  private postBlinds(): void {
    const inHand = this.players.filter((p) => p.status !== 'out')
    const headsUp = inHand.length === 2
    const sbIndex = headsUp ? this.dealerIndex : this.nextEligible(this.dealerIndex)
    const bbIndex = this.nextEligible(sbIndex)
    const sb = this.players[sbIndex]!
    const bb = this.players[bbIndex]!
    this.commit(sb, this.config.smallBlind)
    this.log.push({ kind: 'blind', playerId: sb.id, amount: this.config.smallBlind, blind: 'small' })
    this.commit(bb, this.config.bigBlind)
    this.log.push({ kind: 'blind', playerId: bb.id, amount: this.config.bigBlind, blind: 'big' })
    this.currentBet = this.config.bigBlind
    this.lastRaiseSize = this.config.bigBlind
  }

  private dealHoleCards(): void {
    for (const p of this.players) {
      if (p.status === 'out') continue
      p.holeCards = [this.deck.pop()!, this.deck.pop()!]
    }
  }

  private firstToAct(street: Street): number {
    const inHand = this.players.filter((p) => p.status !== 'out')
    const headsUp = inHand.length === 2
    if (street === 'preflop') {
      // After the blinds: UTG (or dealer/SB heads-up)
      const sbIndex = headsUp ? this.dealerIndex : this.nextEligible(this.dealerIndex)
      const bbIndex = this.nextEligible(sbIndex)
      return this.nextActive(bbIndex) ?? this.toActIndex
    }
    // Postflop: first active player left of dealer
    return this.nextActive(this.dealerIndex) ?? this.toActIndex
  }

  /** Next seat (any non-out player), for blind positions. */
  private nextEligible(from: number): number {
    let i = from
    do {
      i = (i + 1) % this.players.length
    } while (this.players[i]!.status === 'out')
    return i
  }

  /** Next player who can still act (active status), or null. */
  private nextActive(from: number): number | null {
    for (let step = 1; step <= this.players.length; step++) {
      const i = (from + step) % this.players.length
      if (this.players[i]!.status === 'active') return i
    }
    return null
  }

  /** If only one player remains unfolded, award the pot without showdown. */
  private settleIfNoContest(): boolean {
    const contenders = this.players.filter((p) => p.status === 'active' || p.status === 'allin')
    if (contenders.length !== 1) return false
    const winner = contenders[0]!
    winner.stack += this.pot
    this.result = {
      handNumber: this.handNumber,
      winners: [{ playerId: winner.id, amount: this.pot }],
      board: this.board,
      showdown: false,
    }
    this.log.push({ kind: 'hand_end', result: this.result })
    return true
  }

  private advance(): void {
    const next = this.findNextToAct()
    if (next !== null) {
      this.toActIndex = next
      return
    }
    // Street complete
    this.nextStreet()
  }

  private findNextToAct(): number | null {
    for (let step = 1; step <= this.players.length; step++) {
      const i = (this.toActIndex + step) % this.players.length
      const p = this.players[i]!
      if (p.status !== 'active') continue
      if (!p.hasActedThisRound || p.streetBet < this.currentBet) return i
    }
    return null
  }

  private nextStreet(): void {
    for (const p of this.players) {
      p.streetBet = 0
      p.hasActedThisRound = false
    }
    this.currentBet = 0
    this.lastRaiseSize = 0

    const order: Street[] = ['preflop', 'flop', 'turn', 'river', 'showdown']
    this.street = order[order.indexOf(this.street) + 1]!

    if (this.street === 'flop') this.dealBoard(3)
    else if (this.street === 'turn' || this.street === 'river') this.dealBoard(1)
    else if (this.street === 'showdown') return this.showdown()

    // If fewer than 2 players can act (everyone all-in), run out the board
    const actives = this.players.filter((p) => p.status === 'active')
    if (actives.length < 2) return this.nextStreet()

    this.toActIndex = this.firstToAct(this.street)
  }

  private dealBoard(n: number): void {
    for (let i = 0; i < n; i++) this.board.push(this.deck.pop()!)
    this.log.push({ kind: 'deal', street: this.street, board: [...this.board] })
  }

  private showdown(): void {
    const contenders = this.players.filter((p) => p.status === 'active' || p.status === 'allin')
    const scored = contenders.map((p) => ({
      player: p,
      score: evaluate([...p.holeCards, ...this.board]),
    }))
    this.log.push({
      kind: 'showdown',
      hands: scored.map((s) => ({ playerId: s.player.id, cards: s.player.holeCards, handName: s.score.name })),
    })

    // Side pots: layer by all-in commitment levels
    const winners = new Map<string, { amount: number; handName: string }>()
    const levels = [...new Set(contenders.map((p) => p.totalBet))].sort((a, b) => a - b)
    let prevLevel = 0
    for (const level of levels) {
      // Pot layer: contributions between prevLevel and level from EVERY player in the hand
      let layerPot = 0
      for (const p of this.players) {
        layerPot += Math.max(0, Math.min(p.totalBet, level) - prevLevel)
      }
      // Eligible: contenders who committed at least this level
      const eligible = scored.filter((s) => s.player.totalBet >= level)
      const bestValue = Math.max(...eligible.map((s) => s.score.value))
      const layerWinners = eligible.filter((s) => s.score.value === bestValue)
      const share = Math.floor(layerPot / layerWinners.length)
      let remainder = layerPot - share * layerWinners.length
      for (const w of layerWinners) {
        const extra = remainder > 0 ? 1 : 0
        remainder -= extra
        const cur = winners.get(w.player.id) ?? { amount: 0, handName: w.score.name }
        cur.amount += share + extra
        winners.set(w.player.id, cur)
      }
      prevLevel = level
    }

    for (const [playerId, w] of winners) {
      const p = this.players.find((x) => x.id === playerId)!
      p.stack += w.amount
    }

    this.result = {
      handNumber: this.handNumber,
      winners: [...winners.entries()]
        .filter(([, w]) => w.amount > 0)
        .map(([playerId, w]) => ({ playerId, amount: w.amount, handName: w.handName })),
      board: this.board,
      showdown: true,
    }
    this.log.push({ kind: 'hand_end', result: this.result })
  }
}
