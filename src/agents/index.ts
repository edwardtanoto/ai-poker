import { Mppx, tempo } from 'mppx/client'
import { SERVER_URL, formatUsd } from '../config.js'
import type { Card } from '../engine/types.js'
import { cardsToString } from '../engine/cards.js'
import { openWallet } from '../payments/wallet.js'
import { pickBrain, ruleBrain, type Brain, type BrainInput } from './brain.js'

/**
 * An autonomous poker-playing agent:
 *  1. opens (and faucet-funds) its own Tempo testnet wallet,
 *  2. joins the table — the MPP client pays the 402 buy-in challenge on-chain,
 *  3. watches the table log to build a memory of opponents' behavior,
 *  4. thinks through each decision (Claude brain) and talks at the table,
 *  5. plays until the table settles and the treasury cashes it out on-chain.
 */
export async function runAgent(playerId: string, options?: { brain?: Brain; serverUrl?: string }) {
  const serverUrl = options?.serverUrl ?? SERVER_URL
  const wallet = await openWallet(playerId, `.wallets/${playerId}.json`)
  const brain = options?.brain ?? pickBrain(playerId)
  console.log(`[${playerId}] wallet ${wallet.address} · brain: ${brain.name}`)

  // Payment-aware fetch: automatically answers MPP 402 challenges with
  // signed Tempo charge credentials from this agent's wallet.
  const mppx = Mppx.create({
    methods: [tempo({ account: wallet.account, expectedChainId: wallet.client.chain.id })],
    polyfill: false,
  })
  const paidFetch = mppx.fetch

  const balanceBefore = await wallet.balance()

  const joinRes = await paidFetch(`${serverUrl}/api/table/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, address: wallet.address }),
  })
  if (!joinRes.ok) throw new Error(`[${playerId}] join failed (${joinRes.status}): ${await joinRes.text()}`)
  const { token } = (await joinRes.json()) as { token: string }
  const balanceAfterJoin = await wallet.balance()
  console.log(`[${playerId}] seated — paid ${formatUsd(Number(balanceBefore - balanceAfterJoin))} buy-in on-chain`)

  const memory = new GameMemory(playerId, serverUrl, token)

  // Main loop: poll, act when it's our turn
  for (;;) {
    const state = await getState(serverUrl, token)

    if (state.state === 'settled') {
      const payout = state.payouts.find((p) => p.playerId === playerId)
      const balanceEnd = await wallet.balance()
      const net = Number(balanceEnd - balanceBefore)
      console.log(
        `[${playerId}] table settled — ` +
        (payout?.txHash ? `cashed out ${formatUsd(payout.chips)} (tx ${payout.txHash.slice(0, 14)}…) · ` : 'busted · ') +
        `session net: ${net >= 0 ? '+' : ''}${formatUsd(net)}`,
      )
      return { playerId, payout, net }
    }

    const you = state.you
    if (state.state === 'playing' && state.hand && you?.legalActions) {
      await memory.refresh()
      const me = state.hand.players.find((p) => p.id === playerId)!
      const input: BrainInput = {
        playerId,
        holeCards: you.holeCards,
        board: state.hand.board,
        pot: state.hand.pot,
        street: state.hand.street,
        stack: me.stack,
        legal: you.legalActions,
        opponents: state.hand.players.filter((p) => p.id !== playerId),
        handNumber: state.handNumber,
        maxHands: state.maxHands,
        history: memory.lines,
      }
      const output = await brain.decide(input).catch((error) => {
        console.error(`[${playerId}] brain error, falling back to rules:`, error.message)
        return ruleBrain().decide(input)
      })

      // Broadcast thinking + table talk before acting (spectators see the read)
      if (output.say || output.thinking) {
        if (output.thinking) {
          console.log(`[${playerId}] 🧠 ${output.thinking.split('\n')[0]?.slice(0, 140)}`)
        }
        if (output.say) console.log(`[${playerId}] 💬 "${output.say}"`)
        await fetch(`${serverUrl}/api/table/say`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-player-token': token },
          body: JSON.stringify({ say: output.say, thinking: output.thinking }),
        }).catch(() => {})
      }

      const res = await fetch(`${serverUrl}/api/table/act`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-player-token': token },
        body: JSON.stringify(output.decision),
      })
      if (!res.ok) {
        // Turn may have moved on (e.g. duplicate poll) — log and continue
        console.error(`[${playerId}] act rejected (${res.status}): ${await res.text()}`)
      }
      continue
    }

    await new Promise((r) => setTimeout(r, 400))
  }
}

/**
 * The agent's memory: an incrementally-consumed view of the public table log,
 * rendered as text lines for the LLM prompt. Opponents' `thought` events are
 * deliberately excluded — reading minds would be cheating.
 */
class GameMemory {
  lines: string[] = []
  private cursor = 0
  constructor(private playerId: string, private serverUrl: string, private token: string) {}

  async refresh(): Promise<void> {
    const res = await fetch(`${this.serverUrl}/api/table/log`, {
      headers: { 'x-player-token': this.token },
    }).catch(() => null)
    if (!res?.ok) return
    const events = (await res.json()) as { seq: number; type: string; data: Record<string, unknown> }[]
    for (const e of events) {
      if (e.seq <= this.cursor) continue
      this.cursor = e.seq
      const line = this.render(e.type, e.data)
      if (line) this.lines.push(line)
    }
    if (this.lines.length > 200) this.lines = this.lines.slice(-200)
  }

  private render(type: string, d: Record<string, unknown>): string | null {
    const usd = (n: unknown) => formatUsd(Number(n))
    switch (type) {
      case 'hand_start':
        return `--- hand #${d.handNumber} (dealer: ${d.dealerId}) ---`
      case 'blind':
        return `${d.playerId} posts ${d.blind} blind ${usd(d.amount)}`
      case 'deal': {
        const board = d.board as Card[]
        return `${d.street}: ${cardsToString(board)}`
      }
      case 'action':
        return `${d.playerId} ${d.action}${Number(d.amount) > 0 ? ` ${usd(d.amount)}` : ''} (${d.street})`
      case 'showdown': {
        const hands = d.hands as { playerId: string; cards: Card[]; handName: string }[]
        return `showdown: ${hands.map((h) => `${h.playerId} shows ${cardsToString(h.cards)} (${h.handName})`).join(', ')}`
      }
      case 'hand_end': {
        const result = d.result as { winners: { playerId: string; amount: number; handName?: string }[] }
        return `result: ${result.winners.map((w) => `${w.playerId} wins ${usd(w.amount)}${w.handName ? ` with ${w.handName}` : ''}`).join(', ')}`
      }
      case 'chat':
        return `${d.playerId} says: "${d.say}"`
      // 'thought' events are other players' private reasoning — never surfaced
      default:
        return null
    }
  }
}

type TableState = {
  state: string
  handNumber: number
  maxHands: number
  seats: { id: string; chips: number }[]
  hand: {
    street: string
    board: Card[]
    pot: number
    currentPlayerId: string | null
    players: { id: string; status: string; streetBet: number; stack: number }[]
  } | null
  you?: {
    id: string
    holeCards: Card[]
    legalActions: import('../engine/hand.js').LegalActions | null
  }
  payouts: { playerId: string; chips: number; txHash?: string }[]
}

async function getState(serverUrl: string, token: string): Promise<TableState> {
  const res = await fetch(`${serverUrl}/api/table`, { headers: { 'x-player-token': token } })
  if (!res.ok) throw new Error(`state fetch failed: ${res.status}`)
  return (await res.json()) as TableState
}

// CLI entry: `npm run agent -- <playerId>`
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)
if (invokedDirectly) {
  const playerId = process.argv[2] ?? `agent-${Math.floor(Math.random() * 1000)}`
  runAgent(playerId).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
