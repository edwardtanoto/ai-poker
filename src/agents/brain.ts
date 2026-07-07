import { cardsToString } from '../engine/cards.js'
import { evaluate } from '../engine/evaluator.js'
import type { Card } from '../engine/types.js'
import type { LegalActions } from '../engine/hand.js'
import { formatUsd } from '../config.js'
import { personaFor } from './personas.js'

export type Decision = { type: 'fold' | 'check' | 'call' | 'raise' | 'allin'; amount?: number }

export type BrainOutput = {
  decision: Decision
  /** Public table talk, broadcast to everyone. */
  say?: string
  /** The model's (summarized) reasoning — shown to spectators, never to opponents. */
  thinking?: string
}

export type BrainInput = {
  playerId: string
  holeCards: Card[]
  board: Card[]
  pot: number
  street: string
  stack: number
  legal: LegalActions
  opponents: { id: string; stack: number; status: string; streetBet: number }[]
  handNumber: number
  maxHands: number
  /** Recent public events (actions, showdowns, chat) — the agent's memory of the game. */
  history: string[]
}

export type Brain = {
  name: string
  decide: (input: BrainInput) => Promise<BrainOutput>
}

/**
 * Rule-based fallback brain: plays a tight-aggressive game from simple
 * hand-strength heuristics. Used when no Anthropic credentials are configured
 * or as the safety net when the LLM call fails.
 */
export function ruleBrain(rng: () => number = Math.random): Brain {
  return {
    name: 'rules',
    decide: async ({ holeCards, board, legal, pot }) => {
      const strength = handStrength(holeCards, board)
      const jitter = rng() * 0.1 - 0.05
      const s = Math.max(0, Math.min(1, strength + jitter))

      const callPrice = legal.callAmount / Math.max(pot + legal.callAmount, 1)

      if (legal.canCheck) {
        if (s > 0.7 && legal.canRaise) {
          return { decision: { type: 'raise', amount: Math.min(legal.minRaiseTo + Math.floor(pot / 2), legal.maxRaiseTo) } }
        }
        return { decision: { type: 'check' } }
      }
      if (s > 0.85 && legal.canRaise) {
        return { decision: { type: 'raise', amount: Math.min(legal.minRaiseTo * 2, legal.maxRaiseTo) } }
      }
      if (s > callPrice + 0.15 && legal.canCall) return { decision: { type: 'call' } }
      if (legal.callAmount === 0 && legal.canCall) return { decision: { type: 'call' } }
      return { decision: { type: 'fold' } }
    },
  }
}

/** Rough 0..1 strength: preflop chart-ish, postflop from made-hand category. */
function handStrength(hole: Card[], board: Card[]): number {
  if (board.length === 0) {
    const [a, b] = hole as [Card, Card]
    const high = Math.max(a.rank, b.rank)
    const low = Math.min(a.rank, b.rank)
    const pair = a.rank === b.rank
    const suited = a.suit === b.suit
    if (pair) return 0.5 + (high / 14) * 0.5
    let s = (high / 14) * 0.45 + (low / 14) * 0.2
    if (suited) s += 0.08
    if (high - low <= 2) s += 0.05
    return s
  }
  const score = evaluate([...hole, ...board])
  const category = Math.floor(score.value / 16 ** 5) // 0..8
  const boardOnly = board.length >= 5 ? evaluate(board) : null
  const playsTheBoard = boardOnly ? boardOnly.value === score.value : false
  const base = category / 8
  return playsTheBoard ? base * 0.4 : 0.25 + base * 0.75
}

const MODEL = process.env.POKER_MODEL ?? 'claude-opus-4-8'
const EFFORT = (process.env.POKER_EFFORT ?? 'low') as 'low' | 'medium' | 'high'

/**
 * Haiku 4.5 (and Sonnet 4.5) don't support adaptive thinking or the effort
 * parameter — they use the legacy `budget_tokens` form. Everything 4.6+
 * gets adaptive thinking with a summarized display for the spectator feed.
 */
function modelParams(): { thinking: object; effort?: string } {
  if (/haiku|sonnet-4-5/.test(MODEL)) {
    return { thinking: { type: 'enabled', budget_tokens: 3000 } }
  }
  return { thinking: { type: 'adaptive', display: 'summarized' }, effort: EFFORT }
}

/**
 * Claude-powered brain: a persona-driven LLM player with adaptive thinking.
 * Decisions come back as structured JSON; the thinking summary is surfaced
 * to spectators and the `say` field is broadcast as table talk.
 */
export function claudeBrain(playerId: string): Brain {
  const persona = personaFor(playerId)

  return {
    name: `claude(${MODEL}, ${persona.id})`,
    decide: async (input) => {
      const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
        import('@anthropic-ai/sdk'),
        import('zod'),
        import('@anthropic-ai/sdk/helpers/zod'),
      ])
      const client = new Anthropic()

      const DecisionSchema = z.object({
        action: z.enum(['fold', 'check', 'call', 'raise', 'allin']),
        raiseTo: z
          .number()
          .nullable()
          .describe('Only for raise: total street commitment in DOLLARS to raise to (e.g. 1.5 = $1.50)'),
        say: z
          .string()
          .nullable()
          .describe('Optional short table talk said out loud to opponents (max ~120 chars). Stay in character. null to stay silent.'),
      })

      const system = [
        persona.style,
        '',
        "You are playing no-limit Texas Hold'em against other AI agents for real stablecoin stakes on-chain.",
        'Winning chips means winning real money at cash-out. Play to win the whole table.',
        'Core skills you must use: pot odds, position, hand reading from betting lines,',
        'bluffing with credible stories, value betting, and adjusting to each opponent',
        'based on the game history you are shown. Deception is part of the game —',
        'your table talk may lie, but your action must be strategically sound.',
        'Never truthfully reveal your exact hole cards in table talk while a hand',
        'is live — talk is a weapon, not a confession. Opponents read and exploit it.',
      ].join('\n')

      const { legal } = input
      const options: string[] = []
      if (legal.canFold) options.push('fold')
      if (legal.canCheck) options.push('check')
      if (legal.canCall) options.push(`call for ${formatUsd(legal.callAmount)}`)
      if (legal.canRaise) options.push(`raise to between ${formatUsd(legal.minRaiseTo)} and ${formatUsd(legal.maxRaiseTo)} (street total; max = all-in)`)

      const potOdds = legal.callAmount > 0
        ? `Pot odds: calling ${formatUsd(legal.callAmount)} to win ${formatUsd(input.pot + legal.callAmount)} → need ${((legal.callAmount / (input.pot + legal.callAmount)) * 100).toFixed(0)}% equity.`
        : ''

      const historyBlock = input.history.length
        ? `Game history (your memory — use it to model opponents):\n${input.history.slice(-60).join('\n')}`
        : 'No history yet — first hand.'

      const prompt = [
        `Hand #${input.handNumber} of ${input.maxHands} · street: ${input.street}`,
        `Your hole cards (SECRET): ${cardsToString(input.holeCards)}`,
        `Board: ${input.board.length ? cardsToString(input.board) : 'none yet'}`,
        `Pot: ${formatUsd(input.pot)} · Your stack: ${formatUsd(input.stack)}`,
        `Opponents: ${input.opponents.map((o) => `${o.id} (stack ${formatUsd(o.stack)}, ${o.status}, street bet ${formatUsd(o.streetBet)})`).join('; ')}`,
        potOdds,
        '',
        historyBlock,
        '',
        `Your legal options: ${options.join(' | ')}`,
        'Decide your action.',
      ].filter(Boolean).join('\n')

      const params = modelParams()
      const response = await client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        thinking: params.thinking as never,
        output_config: {
          ...(params.effort ? { effort: params.effort as 'low' } : {}),
          format: zodOutputFormat(DecisionSchema),
        },
        system,
        messages: [{ role: 'user', content: prompt }],
      })

      const thinking = response.content
        .filter((b) => b.type === 'thinking')
        .map((b) => b.thinking)
        .join('\n')
        .trim() || undefined

      const parsed = response.parsed_output
      if (!parsed) throw new Error(`No structured decision (stop_reason: ${response.stop_reason})`)

      const say = parsed.say?.slice(0, 160) || undefined
      const decision = toLegalDecision(parsed, legal)
      return { decision, say, thinking }
    },
  }
}

/** Clamps the model's intent to a legal action so an off-by-one never crashes the turn. */
function toLegalDecision(
  parsed: { action: string; raiseTo?: number | null },
  legal: LegalActions,
): Decision {
  switch (parsed.action) {
    case 'fold': return legal.canFold ? { type: 'fold' } : { type: 'check' }
    case 'check': return legal.canCheck ? { type: 'check' } : { type: 'fold' }
    case 'call': return legal.canCall ? { type: 'call' } : { type: 'check' }
    case 'allin': return legal.canRaise
      ? { type: 'raise', amount: legal.maxRaiseTo }
      : legal.canCall ? { type: 'call' } : { type: 'check' }
    case 'raise': {
      if (!legal.canRaise) return legal.canCall ? { type: 'call' } : { type: 'check' }
      const chips = Math.round((parsed.raiseTo ?? 0) * 1e6)
      return { type: 'raise', amount: Math.max(legal.minRaiseTo, Math.min(chips, legal.maxRaiseTo)) }
    }
    default: return legal.canCheck ? { type: 'check' } : { type: 'fold' }
  }
}

export function pickBrain(playerId: string): Brain {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return claudeBrain(playerId)
  console.log(`[${playerId}] no ANTHROPIC_API_KEY — using rule-based fallback brain`)
  return ruleBrain()
}
