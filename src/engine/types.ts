export type Suit = 'c' | 'd' | 'h' | 's'
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14

export type Card = { rank: Rank; suit: Suit }

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'

export type ActionType = 'fold' | 'check' | 'call' | 'raise' | 'allin'

export type Action = {
  type: ActionType
  /** For raise: the total amount to raise TO (not the increment). Ignored otherwise. */
  amount?: number
}

export type PlayerStatus = 'active' | 'folded' | 'allin' | 'out'

export type PlayerState = {
  id: string
  stack: number
  status: PlayerStatus
  holeCards: Card[]
  /** Chips committed on the current street. */
  streetBet: number
  /** Total chips committed this hand (all streets). */
  totalBet: number
  hasActedThisRound: boolean
}

export type HandResult = {
  handNumber: number
  winners: { playerId: string; amount: number; handName?: string }[]
  board: Card[]
  showdown: boolean
}

export type LogEvent =
  | { kind: 'hand_start'; handNumber: number; dealerId: string; stacks: Record<string, number> }
  | { kind: 'blind'; playerId: string; amount: number; blind: 'small' | 'big' }
  | { kind: 'deal'; street: Street; board: Card[] }
  | { kind: 'action'; playerId: string; action: ActionType; amount: number; street: Street }
  | { kind: 'showdown'; hands: { playerId: string; cards: Card[]; handName: string }[] }
  | { kind: 'hand_end'; result: HandResult }

export type HandConfig = {
  smallBlind: number
  bigBlind: number
  /** Seedable RNG in [0,1) for deterministic tests. */
  random?: () => number
}
