'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Brain, CircleDollarSign, Play, RotateCcw, ShieldCheck, Sparkles, WalletCards } from 'lucide-react'

type Suit = 'c' | 'd' | 'h' | 's'
type Card = { rank: number; suit: Suit }
type Seat = { id: string; address: string; chips: number }
type Player = {
  id: string
  address?: string
  chips?: number
  stack?: number
  status?: string
  streetBet?: number
  holeCards?: Card[]
}
type TableEvent = { seq: number; time: number; type: string; data: Record<string, unknown> }
type Payout = { playerId: string; address: string; chips: number; txHash?: string; error?: string }
type TableState = {
  state: 'waiting' | 'playing' | 'settling' | 'settled'
  handNumber: number
  maxHands: number
  blinds: { small: number; big: number }
  seats: Seat[]
  hand: {
    street: string
    board: Card[]
    pot: number
    currentPlayerId: string | null
    players: Player[]
  } | null
  payouts: Payout[]
}

const SUITS: Record<Suit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' }
const RANKS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }
const PERSONA_BLURBS: Record<string, string> = {
  'ace-bot': 'tight-aggressive math grinder',
  'river-rat': 'loose trickster, river pressure',
  'bluff-machine': 'fearless pressure engine',
  'tilt-proof': 'calm GTO-leaning adjuster',
}

const initialTable: TableState = {
  state: 'waiting',
  handNumber: 0,
  maxHands: 0,
  blinds: { small: 0, big: 0 },
  seats: [],
  hand: null,
  payouts: [],
}

export function SpectatorTable() {
  const [table, setTable] = useState<TableState>(initialTable)
  const [events, setEvents] = useState<TableEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/table', { cache: 'no-store' })
    if (!res.ok) throw new Error(`table fetch failed: ${res.status}`)
    setTable(await res.json())
  }, [])

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
    const source = new EventSource('/api/table/events')
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as TableEvent
      setEvents((prev) => [...prev.slice(-159), event])
      void refresh()
    }
    source.onerror = () => setError('Live stream disconnected. Refreshing still works.')
    return () => source.close()
  }, [refresh])

  const players = useMemo(() => {
    return table.seats.map((seat) => {
      const handPlayer = table.hand?.players.find((player) => player.id === seat.id)
      return { ...seat, ...handPlayer, chips: handPlayer?.stack ?? seat.chips }
    })
  }, [table])

  const startMatch = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/table/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seats: 2 }),
      })
      if (!res.ok) throw new Error(await res.text())
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const resetMatch = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/table/reset', { method: 'POST' })
      if (!res.ok) throw new Error(await res.text())
      setEvents([])
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const latestThought = [...events].reverse().find((event) => event.type === 'thought')
  const latestAction = [...events].reverse().find((event) => event.type === 'action' || event.type === 'hand_end')

  return (
    <main className="arena-shell">
      <section className="command-rail" aria-label="Match controls and status">
        <div>
          <div className="brand-row">
            <span className="brand-mark">AI</span>
            <span>AI Poker Arena</span>
          </div>
          <h1>Autonomous agents playing x402 poker.</h1>
          <p>
            Spectators see every card and every on-chain receipt. Agents only receive their private table view.
          </p>
        </div>

        <div className="control-row">
          <button type="button" className="primary-button" onClick={startMatch} disabled={busy || table.state === 'playing' || table.state === 'settling'}>
            <Play aria-hidden size={18} />
            Start match
          </button>
          <button type="button" className="icon-button" onClick={resetMatch} disabled={busy || table.state === 'settling'} title="Reset table">
            <RotateCcw aria-hidden size={18} />
          </button>
        </div>

        <div className="status-grid">
          <Metric icon={<Sparkles size={16} />} label="State" value={table.state} />
          <Metric icon={<WalletCards size={16} />} label="Hands" value={`${table.handNumber}/${table.maxHands || '∞'}`} />
          <Metric icon={<CircleDollarSign size={16} />} label="Pot" value={table.hand ? usd(table.hand.pot) : '$0.00'} />
          <Metric icon={<ShieldCheck size={16} />} label="Mode" value="testnet" />
        </div>
        {error ? <p className="error-line">{error}</p> : null}
      </section>

      <section className="table-stage" aria-label="Live poker table">
        <div className="felt-table">
          <div className="street-label">{table.hand?.street ?? 'waiting'}</div>
          <div className="board-row">
            {table.hand?.board.length ? table.hand.board.map((card, index) => <CardView key={`${card.rank}${card.suit}${index}`} card={card} />) : (
              Array.from({ length: 5 }, (_, index) => <div className="card-slot" key={index} />)
            )}
          </div>
          <div className="pot-display">
            <span>Pot</span>
            <strong>{table.hand ? usd(table.hand.pot) : '$0.00'}</strong>
          </div>
        </div>

        <div className="seat-grid">
          {players.length ? players.map((player) => (
            <AgentSeat key={player.id} player={player} active={table.hand?.currentPlayerId === player.id} />
          )) : (
            <div className="empty-seat">
              <Brain size={22} />
              <span>No agents seated. Start a match to trigger testnet buy-ins.</span>
            </div>
          )}
        </div>
      </section>

      <aside className="insight-panel" aria-label="Live match feed">
        <div className="panel-section">
          <h2>Agent Read</h2>
          <p className="thought-copy">
            {latestThought ? String(latestThought.data.thinking ?? '').slice(0, 260) : 'Waiting for the first model decision.'}
          </p>
        </div>
        <div className="panel-section">
          <h2>Last Move</h2>
          <p className="event-copy">{latestAction ? describeEvent(latestAction) : 'No action yet.'}</p>
        </div>
        {table.payouts.length ? (
          <div className="panel-section">
            <h2>Settlement</h2>
            <div className="receipt-list">
              {table.payouts.map((payout) => (
                <div className="receipt-row" key={payout.playerId}>
                  <div>
                    <strong>{payout.playerId}</strong>
                    <span>{usd(payout.chips)} to {shortAddress(payout.address)}</span>
                  </div>
                  <code>{payout.txHash ? shortHash(payout.txHash) : payout.error ?? 'pending'}</code>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="panel-section grow">
          <h2>Live Log</h2>
          <div className="event-list">
            {events.slice(-28).map((event) => (
              <div className={`event-line ${event.type}`} key={event.seq}>
                <time>{new Date(event.time).toLocaleTimeString()}</time>
                <span>{describeEvent(event)}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </main>
  )
}

function AgentSeat({ player, active }: { player: Player & { address: string; chips: number }; active: boolean }) {
  return (
    <article className={`agent-seat ${active ? 'active' : ''} ${player.status === 'folded' ? 'folded' : ''}`}>
      <div className="agent-topline">
        <div>
          <h2>{player.id}</h2>
          <p>{PERSONA_BLURBS[player.id] ?? 'adaptive poker model'}</p>
        </div>
        <span className="provider-pill">Claude</span>
      </div>
      <div className="hole-row">
        {player.holeCards?.length ? player.holeCards.map((card, index) => <CardView key={`${card.rank}${card.suit}${index}`} card={card} compact />) : (
          <>
            <div className="card-back" />
            <div className="card-back" />
          </>
        )}
      </div>
      <div className="agent-stats">
        <span>{usd(player.chips)}</span>
        <span>{player.status ?? 'seated'}</span>
        <span>{player.streetBet ? `bet ${usd(player.streetBet)}` : 'no bet'}</span>
      </div>
      <p className="address-line">{shortAddress(player.address)}</p>
    </article>
  )
}

function CardView({ card, compact = false }: { card: Card; compact?: boolean }) {
  const red = card.suit === 'h' || card.suit === 'd'
  return (
    <div className={`playing-card ${compact ? 'compact' : ''} ${red ? 'red' : ''}`}>
      <span>{RANKS[card.rank] ?? card.rank}</span>
      <span>{SUITS[card.suit]}</span>
    </div>
  )
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function describeEvent(event: TableEvent): string {
  const d = event.data
  switch (event.type) {
    case 'demo_started':
      return `Match started: ${(d.players as string[]).join(' vs ')}`
    case 'player_joined':
      return `${d.playerId} bought in for ${d.buyIn}`
    case 'hand_start':
      return `Hand #${d.handNumber}, dealer ${d.dealerId}`
    case 'blind':
      return `${d.playerId} posts ${d.blind} blind ${usd(Number(d.amount))}`
    case 'deal':
      return `${d.street}: ${((d.board as Card[]) ?? []).map(cardLabel).join(' ')}`
    case 'action':
      return `${d.playerId} ${d.action}${Number(d.amount) > 0 ? ` ${usd(Number(d.amount))}` : ''}`
    case 'showdown':
      return `Showdown: ${((d.hands as { playerId: string; handName: string }[]) ?? []).map((hand) => `${hand.playerId} ${hand.handName}`).join(', ')}`
    case 'hand_end': {
      const result = d.result as { winners: { playerId: string; amount: number; handName?: string }[] }
      return result.winners.map((winner) => `${winner.playerId} wins ${usd(winner.amount)}${winner.handName ? ` with ${winner.handName}` : ''}`).join(', ')
    }
    case 'chat':
      return `${d.playerId}: "${d.say}"`
    case 'thought':
      return `${d.playerId} thinks: ${String(d.thinking ?? '').slice(0, 160)}`
    case 'payout':
      return `${d.playerId} cashed out ${d.amount}`
    case 'payout_failed':
      return `Payout failed for ${d.playerId}`
    case 'settling':
      return 'Game over, settling on-chain'
    case 'settled':
      return `Table settled after ${d.hands} hands`
    case 'demo_finished':
      return 'Agent workers finished'
    default:
      return event.type
  }
}

function cardLabel(card: Card): string {
  return `${RANKS[card.rank] ?? card.rank}${SUITS[card.suit]}`
}

function usd(chips: number): string {
  return `$${(chips / 1e6).toFixed(2)}`
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}
