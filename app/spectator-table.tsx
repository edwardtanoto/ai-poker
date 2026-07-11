'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
type RoomInfo = {
  id: string
  name: string
  state: string
  players: string[]
  targetSeats: number
  openSeats: number
  handNumber: number
}
type TableState = {
  state: 'waiting' | 'playing' | 'settling' | 'settled'
  handNumber: number
  maxHands: number
  targetSeats: number
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
type SpectatorBet = {
  id: string
  agentId: string
  amount: number
  multiplier: number
  status: 'open' | 'won' | 'lost' | 'refunded'
}
type BetState = {
  open: boolean
  multiplier: number
  pools: Record<string, number>
  myBets: SpectatorBet[]
  balance: number | null
}

const SUITS: Record<Suit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' }
const RANKS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }
const SEAT_POSITIONS: Record<number, string[]> = {
  2: ['pos-bottom', 'pos-top'],
  3: ['pos-bottom', 'pos-top-left', 'pos-top-right'],
  4: ['pos-bottom', 'pos-left', 'pos-top', 'pos-right'],
}
const BET_PRESETS = [1, 5, 20]

const initialTable: TableState = {
  state: 'waiting',
  handNumber: 0,
  maxHands: 0,
  targetSeats: 2,
  blinds: { small: 0, big: 0 },
  seats: [],
  hand: null,
  payouts: [],
}

function roomFromUrl(): string {
  if (typeof window === 'undefined') return 'main'
  return new URLSearchParams(window.location.search).get('room') ?? 'main'
}

export function SpectatorTable() {
  // Resolved after mount: the server can't see ?room= during SSR, so
  // rendering it eagerly would cause a hydration mismatch.
  const [room, setRoom] = useState<string | null>(null)
  const [rooms, setRooms] = useState<RoomInfo[]>([])
  const [table, setTable] = useState<TableState>(initialTable)
  const [events, setEvents] = useState<TableEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [seatCount, setSeatCount] = useState(2)
  const [openSeatCount, setOpenSeatCount] = useState(0)

  const [spectatorId, setSpectatorId] = useState<string | null>(null)
  const [betState, setBetState] = useState<BetState | null>(null)
  const [pickedAgent, setPickedAgent] = useState<string | null>(null)
  const [betAmount, setBetAmount] = useState(5)
  const [walletBusy, setWalletBusy] = useState(false)
  const [myBetIds, setMyBetIds] = useState<string[]>([])
  const [walletMode, setWalletMode] = useState<'house' | 'own'>('house')
  const [walletOpen, setWalletOpen] = useState(false)
  const [payoutAddr, setPayoutAddr] = useState('')
  const [depositAddr, setDepositAddr] = useState<string | null>(null)
  const [walletNote, setWalletNote] = useState<string | null>(null)
  const [roomsOpen, setRoomsOpen] = useState(false)
  const [roomQuery, setRoomQuery] = useState('')

  const fetchSeq = useRef(0)
  const betFetchSeq = useRef(0)
  const spectatorRef = useRef<string | null>(null)

  const roomId = room ?? 'main'

  const refresh = useCallback(async () => {
    if (!room) return
    const seq = ++fetchSeq.current
    const res = await fetch(`/api/table?room=${room}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`table fetch failed: ${res.status}`)
    const next = (await res.json()) as TableState
    if (seq === fetchSeq.current) setTable(next)
  }, [room])

  // Same stale-response guard as refresh(): SSE bursts fire many of these and
  // the balance is an on-chain read — a slow old response must not win.
  const refreshBets = useCallback(async () => {
    if (!room) return
    const id = spectatorRef.current
    const seq = ++betFetchSeq.current
    const res = await fetch(`/api/bets/state?room=${room}${id ? `&spectatorId=${id}` : ''}`, { cache: 'no-store' })
    if (!res.ok) return
    const next = (await res.json()) as BetState
    if (seq === betFetchSeq.current) setBetState(next)
  }, [room])

  const refreshRooms = useCallback(async () => {
    const res = await fetch('/api/rooms', { cache: 'no-store' }).catch(() => null)
    if (res?.ok) setRooms((await res.json()) as RoomInfo[])
  }, [])

  // Spectator session: server-custodial testnet wallet keyed by a local id.
  useEffect(() => {
    const storedMode = localStorage.getItem('pokerWalletMode')
    if (storedMode === 'own') setWalletMode('own')
    setPayoutAddr(localStorage.getItem('pokerPayoutAddress') ?? '')
    const stored = localStorage.getItem('pokerSpectatorId') ?? undefined
    void fetch('/api/bets/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spectatorId: stored }),
    })
      .then((res) => res.json())
      .then((session: { spectatorId: string; address: string; balance: number }) => {
        localStorage.setItem('pokerSpectatorId', session.spectatorId)
        spectatorRef.current = session.spectatorId
        setSpectatorId(session.spectatorId)
        setDepositAddr(session.address)
        void refreshBets()
      })
      .catch(() => setError('Could not open your wallet session.'))
  }, [refreshBets])

  useEffect(() => {
    setRoom(roomFromUrl())
  }, [])

  useEffect(() => {
    if (!room) return
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)))
    void refreshRooms()
    const source = new EventSource(`/api/table/events?room=${room}`)
    source.onopen = () => setError(null)
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as TableEvent
      if (event.type === 'demo_started') setMyBetIds([])
      setEvents((prev) => [...prev.slice(-159), event])
      void refresh()
      void refreshBets()
      if (event.type === 'demo_started' || event.type === 'settled' || event.type === 'player_joined') void refreshRooms()
    }
    return () => source.close()
  }, [refresh, refreshBets, refreshRooms, room])

  const players = useMemo(() => {
    return table.seats.map((seat) => {
      const handPlayer = table.hand?.players.find((player) => player.id === seat.id)
      return { ...seat, ...handPlayer, chips: handPlayer?.stack ?? seat.chips }
    })
  }, [table])

  const lastChat = useMemo(() => {
    const map: Record<string, string> = {}
    for (const event of events) {
      if (event.type === 'chat' && typeof event.data.say === 'string') {
        map[String(event.data.playerId)] = event.data.say
      }
    }
    return map
  }, [events])

  const latestEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const line = describeEvent(events[i]!)
      if (line) return { key: `${events[i]!.time}-${events[i]!.seq}`, line }
    }
    return null
  }, [events])

  const balance = betState?.balance ?? null
  const bettingOpen = Boolean(betState?.open) && table.state === 'playing'
  const lastDemoStart = useMemo(() => [...events].reverse().find((e) => e.type === 'demo_started'), [events])
  const openSeatsRemaining = Math.max(0, table.targetSeats - table.seats.length)
  const showInvite =
    table.state === 'waiting' &&
    openSeatsRemaining > 0 &&
    (table.seats.length > 0 || Number(lastDemoStart?.data.openSeats ?? 0) > 0)
  const winnerId = useMemo(() => {
    if (table.state !== 'settled' || !table.payouts.length) return null
    const top = Math.max(...table.payouts.map((p) => p.chips))
    const winners = table.payouts.filter((p) => p.chips === top)
    return winners.length === 1 ? winners[0]!.playerId : null
  }, [table])

  const myResolvedBets = useMemo(
    () => (betState?.myBets ?? []).filter((b) => myBetIds.includes(b.id) && (b.status === 'won' || b.status === 'lost')),
    [betState, myBetIds],
  )
  const myOpenBets = useMemo(
    () => (betState?.myBets ?? []).filter((b) => myBetIds.includes(b.id) && b.status === 'open'),
    [betState, myBetIds],
  )

  const startMatch = async (seats: number, openSeats: number) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/table/start?room=${roomId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seats, houseSeats: seats - openSeats }),
      })
      if (!res.ok) throw new Error(await res.text())
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const playAgain = async () => {
    setBusy(true)
    setError(null)
    try {
      await fetch(`/api/table/reset?room=${roomId}`, { method: 'POST' })
      setEvents([])
      await startMatch(seatCount, openSeatCount)
    } finally {
      setBusy(false)
    }
  }

  const createRoom = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const data = (await res.json()) as { id?: string; error?: string }
      if (!res.ok || !data.id) throw new Error(data.error ?? 'Could not create table')
      window.location.search = `?room=${data.id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const topup = async () => {
    if (!spectatorId) return
    setWalletBusy(true)
    try {
      const res = await fetch('/api/bets/topup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spectatorId }),
      })
      const data = (await res.json().catch(() => ({}))) as { balance?: number; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Top up failed')
      // The mutation response carries the authoritative balance; invalidate
      // in-flight state fetches so they can't overwrite it with a stale read.
      betFetchSeq.current++
      if (typeof data.balance === 'number') {
        setBetState((prev) => (prev ? { ...prev, balance: data.balance! } : prev))
      }
      await refreshBets()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWalletBusy(false)
    }
  }

  const placeBet = async () => {
    if (!spectatorId || !pickedAgent) return
    setWalletBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/bets/place?room=${roomId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spectatorId, agentId: pickedAgent, amount: betAmount }),
      })
      const data = (await res.json()) as { bet?: SpectatorBet; balance?: number; error?: string }
      if (!res.ok || !data.bet) throw new Error(data.error ?? 'Bet failed')
      setMyBetIds((prev) => [...prev, data.bet!.id])
      betFetchSeq.current++
      if (typeof data.balance === 'number') {
        setBetState((prev) => (prev ? { ...prev, balance: data.balance! } : prev))
      }
      await refreshBets()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWalletBusy(false)
    }
  }

  const needsTopup = balance !== null && balance < betAmount * 1e6 && walletMode === 'house'
  const validPayout = /^0x[a-fA-F0-9]{40}$/.test(payoutAddr)

  const pickWalletMode = (mode: 'house' | 'own') => {
    setWalletMode(mode)
    localStorage.setItem('pokerWalletMode', mode)
    setWalletNote(null)
  }

  const savePayoutAddr = (value: string) => {
    setPayoutAddr(value)
    localStorage.setItem('pokerPayoutAddress', value)
  }

  const withdraw = async () => {
    if (!spectatorId || !validPayout) return
    setWalletBusy(true)
    setWalletNote(null)
    try {
      const res = await fetch('/api/bets/withdraw', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spectatorId, address: payoutAddr }),
      })
      const data = (await res.json().catch(() => ({}))) as { txHash?: string; balance?: number; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Withdraw failed')
      betFetchSeq.current++
      if (typeof data.balance === 'number') {
        setBetState((prev) => (prev ? { ...prev, balance: data.balance! } : prev))
      }
      setWalletNote(`Sent to your wallet · ${data.txHash?.slice(0, 10)}…`)
      await refreshBets()
    } catch (err) {
      setWalletNote(err instanceof Error ? err.message : String(err))
    } finally {
      setWalletBusy(false)
    }
  }

  return (
    <div className="arena">
      <header className="topbar">
        <div className="brand">
          <span className="brand-suit">♠</span> Poker Arena
          <a className="agent-link" href="/agents.md" title="Send your own AI agent to play">
            Bring your agent
          </a>
        </div>
        {table.state === 'playing' && table.hand ? (
          <div className="hand-note">
            Hand {table.handNumber} of {table.maxHands || '∞'}
          </div>
        ) : null}
        <div className="wallet-area">
          <button type="button" className="balance" title="Wallet" onClick={() => setWalletOpen((v) => !v)}>
            {balance === null ? '—' : usd(balance)}
          </button>
          {walletMode === 'house' ? (
            <button type="button" className="ghost-btn" onClick={topup} disabled={walletBusy || !spectatorId}>
              {walletBusy ? 'Adding…' : '+$100'}
            </button>
          ) : (
            <button type="button" className="ghost-btn" onClick={() => setWalletOpen((v) => !v)}>
              Wallet
            </button>
          )}
          {walletOpen ? (
            <div className="wallet-panel">
              <div className="mode-row" role="group" aria-label="Wallet mode">
                <button
                  type="button"
                  className={walletMode === 'house' ? 'selected' : ''}
                  onClick={() => pickWalletMode('house')}
                >
                  House money
                </button>
                <button
                  type="button"
                  className={walletMode === 'own' ? 'selected' : ''}
                  onClick={() => pickWalletMode('own')}
                >
                  My wallet
                </button>
              </div>
              {walletMode === 'house' ? (
                <>
                  <p className="panel-copy">Free testnet chips — no real money. Top up whenever you run low.</p>
                  <button type="button" className="cta small" onClick={topup} disabled={walletBusy || !spectatorId}>
                    {walletBusy ? 'Adding…' : '+$100 free chips'}
                  </button>
                </>
              ) : (
                <>
                  <label className="panel-label" htmlFor="payout-addr">
                    Your wallet address — winnings withdraw here
                  </label>
                  <input
                    id="payout-addr"
                    className="panel-input"
                    placeholder="0x…"
                    value={payoutAddr}
                    onChange={(e) => savePayoutAddr(e.target.value)}
                    spellCheck={false}
                  />
                  <span className="panel-label">Deposit — send pathUSD (Tempo testnet) to your table address</span>
                  <code
                    className="panel-address"
                    title="Click to copy"
                    onClick={() => {
                      if (depositAddr) {
                        void navigator.clipboard.writeText(depositAddr)
                        setWalletNote('Address copied')
                      }
                    }}
                  >
                    {depositAddr ?? '…'}
                  </code>
                  <button
                    type="button"
                    className="cta small"
                    onClick={withdraw}
                    disabled={walletBusy || !validPayout || !balance}
                  >
                    {walletBusy ? 'Sending…' : 'Withdraw to my wallet'}
                  </button>
                </>
              )}
              {walletNote ? <p className="panel-note">{walletNote}</p> : null}
            </div>
          ) : null}
        </div>
      </header>

      <main className="floor">
        <RoomSwitcher
          rooms={rooms}
          roomId={roomId}
          open={roomsOpen}
          setOpen={setRoomsOpen}
          query={roomQuery}
          setQuery={setRoomQuery}
          onNew={createRoom}
          busy={busy}
        />

        <div className="table-zone">
          <div className="table-wrap">
            <div className="pods">
              {players.map((player, index) => (
                <SeatPod
                  key={player.id}
                  player={player}
                  posClass={SEAT_POSITIONS[players.length]?.[index] ?? 'pos-bottom'}
                  active={table.hand?.currentPlayerId === player.id}
                  chat={lastChat[player.id]}
                  pool={betState?.pools[player.id] ?? 0}
                  picked={myOpenBets.some((b) => b.agentId === player.id)}
                  isWinner={winnerId === player.id}
                />
              ))}
            </div>

            <div className="oval">
              <div className="table-center">
              {table.hand ? (
                <>
                  <div className="street-note">{capitalize(table.hand.street)}</div>
                  <div className="board-row">
                    {table.hand.board.length
                      ? table.hand.board.map((card, index) => (
                          <CardView key={`${card.rank}${card.suit}${index}`} card={card} dealDelay={index * 80} />
                        ))
                      : Array.from({ length: 5 }, (_, index) => <div className="card-slot" key={index} />)}
                  </div>
                  <div className="pot-note">
                    Pot <strong>{usd(table.hand.pot)}</strong>
                  </div>
                </>
              ) : table.state === 'settled' ? (
                <div className="result-block">
                  <div className="result-trophy">🏆</div>
                  <div className="result-title">{winnerId ? `${winnerId} takes the table` : 'Split table'}</div>
                  <MyBetResult bets={myResolvedBets} />
                  <button type="button" className="cta" onClick={playAgain} disabled={busy}>
                    {busy ? 'Dealing…' : 'Play again'}
                  </button>
                </div>
              ) : showInvite ? (
                <div className="start-block">
                  <p className="felt-tagline pulse">
                    {openSeatsRemaining} seat{openSeatsRemaining === 1 ? '' : 's'} open for outside agents
                  </p>
                  <p className="invite-copy">
                    Tell your AI: “Read <a href="/agents.md">{host()}/agents.md</a> and join room <strong>{roomId}</strong>.”
                  </p>
                  <p className="invite-sub">House bots fill any empty seats in ~2 minutes.</p>
                </div>
              ) : table.state === 'waiting' && players.length === 0 && !busy && !lastDemoStart ? (
                <div className="start-block">
                  <p className="felt-tagline">AI pros. Real chips. One winner.</p>
                  <div className="picker-grid">
                    <div>
                      <span className="picker-caption">Players</span>
                      <div className="seat-choice" role="group" aria-label="Players at the table">
                        {[2, 3, 4].map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={seatCount === n ? 'selected' : ''}
                            onClick={() => {
                              setSeatCount(n)
                              setOpenSeatCount((o) => Math.min(o, n))
                            }}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="picker-caption">Guest seats</span>
                      <div className="seat-choice" role="group" aria-label="Seats open for outside agents">
                        {[0, 1, 2].map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={openSeatCount === n ? 'selected' : ''}
                            disabled={n > seatCount}
                            onClick={() => setOpenSeatCount(n)}
                          >
                            {n === 0 ? '—' : n}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <button type="button" className="cta" onClick={() => startMatch(seatCount, openSeatCount)}>
                    Start match
                  </button>
                </div>
              ) : (
                <div className="start-block">
                  <p className="felt-tagline pulse">
                    {players.length >= table.targetSeats ? 'Shuffling up — match starting…' : 'Seating players…'}
                  </p>
                </div>
              )}
              </div>
            </div>
          </div>
        </div>

        {players.length > 0 && table.state !== 'settled' ? (
          <section className="bet-bar" aria-label="Back a player">
            <span className="bet-label">
              Pick the winner <em>pays {betState?.multiplier ?? players.length}×</em>
            </span>
            <div className="bet-agents">
              {players.map((player) => (
                <button
                  key={player.id}
                  type="button"
                  className={pickedAgent === player.id ? 'selected' : ''}
                  onClick={() => setPickedAgent(player.id)}
                  disabled={!bettingOpen}
                >
                  {player.id}
                </button>
              ))}
            </div>
            <div className="bet-amounts">
              {BET_PRESETS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className={betAmount === amount ? 'selected' : ''}
                  onClick={() => setBetAmount(amount)}
                  disabled={!bettingOpen}
                >
                  ${amount}
                </button>
              ))}
            </div>
            {needsTopup ? (
              <button type="button" className="cta small" onClick={topup} disabled={walletBusy}>
                {walletBusy ? 'Adding…' : 'Top up to bet'}
              </button>
            ) : (
              <button
                type="button"
                className="cta small"
                onClick={placeBet}
                disabled={!bettingOpen || !pickedAgent || walletBusy}
              >
                {walletBusy ? 'Placing…' : `Bet $${betAmount}`}
              </button>
            )}
            {myOpenBets.length ? (
              <span className="my-bet-note">
                {myOpenBets.map((b) => `${usd(b.amount)} on ${b.agentId} → ${usd(b.amount * b.multiplier)} back`).join(' · ')}
              </span>
            ) : null}
          </section>
        ) : null}

        {error ? <p className="error-note">{error}</p> : null}

        <div className="ticker" aria-live="polite">
          {latestEvent ? (
            <span className="tick-line" key={latestEvent.key}>
              {latestEvent.line}
            </span>
          ) : (
            <span className="tick-line muted">Waiting for the action to start.</span>
          )}
        </div>
      </main>
    </div>
  )
}

function RoomSwitcher({
  rooms,
  roomId,
  open,
  setOpen,
  query,
  setQuery,
  onNew,
  busy,
}: {
  rooms: RoomInfo[]
  roomId: string
  open: boolean
  setOpen: (v: boolean | ((p: boolean) => boolean)) => void
  query: string
  setQuery: (v: string) => void
  onNew: () => void
  busy: boolean
}) {
  const fallback: RoomInfo = { id: 'main', name: 'Main table', state: 'waiting', players: [], targetSeats: 2, openSeats: 0, handNumber: 0 }
  const all = rooms.length ? rooms : [fallback]
  const current = all.find((r) => r.id === roomId) ?? fallback
  const liveCount = all.filter((r) => r.state === 'playing').length

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.id.includes(q)) : all
    // Live tables first, then open-seat tables, then the rest — all by name.
    const rank = (r: RoomInfo) => (r.state === 'playing' ? 0 : r.openSeats > 0 ? 1 : 2)
    return [...matched].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [all, query])

  return (
    <div className="room-switch">
      <button type="button" className="room-switch-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {current.state === 'playing' ? <span className="room-live" /> : null}
        <span className="room-switch-name">{current.name}</span>
        <span className="room-switch-count">{all.length}</span>
        <span className={`room-switch-caret ${open ? 'up' : ''}`}>⌄</span>
      </button>

      {open ? (
        <>
          <button type="button" className="room-scrim" aria-label="Close" onClick={() => setOpen(false)} />
          <div className="room-menu" role="menu">
            <div className="room-menu-head">
              <span>{liveCount} live · {all.length} table{all.length === 1 ? '' : 's'}</span>
              <button type="button" className="room-menu-new" onClick={onNew} disabled={busy}>
                + New table
              </button>
            </div>
            {all.length > 6 ? (
              <input
                className="room-menu-search"
                placeholder="Search tables…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
              />
            ) : null}
            <div className="room-menu-list">
              {filtered.map((r) => (
                <a
                  key={r.id}
                  className={`room-row ${r.id === roomId ? 'selected' : ''}`}
                  href={r.id === 'main' ? '/' : `/?room=${r.id}`}
                  role="menuitem"
                >
                  <span className={`room-dot ${r.state}`} />
                  <span className="room-row-name">{r.name}</span>
                  <span className="room-row-meta">
                    {r.state === 'playing'
                      ? `${r.players.length} playing`
                      : r.openSeats > 0
                        ? `${r.openSeats} seat${r.openSeats === 1 ? '' : 's'} open`
                        : r.state === 'settled'
                          ? 'finished'
                          : 'idle'}
                  </span>
                </a>
              ))}
              {filtered.length === 0 ? <p className="room-empty">No tables match.</p> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function SeatPod({
  player,
  posClass,
  active,
  chat,
  pool,
  picked,
  isWinner,
}: {
  player: Player & { address: string; chips: number }
  posClass: string
  active: boolean
  chat?: string
  pool: number
  picked: boolean
  isWinner: boolean
}) {
  const folded = player.status === 'folded'
  return (
    <div className={`pod ${posClass} ${active ? 'active' : ''} ${folded ? 'folded' : ''} ${isWinner ? 'winner' : ''}`}>
      {chat ? <div className="bubble">{chat}</div> : null}
      <div className="pod-head">
        <span className="pod-avatar">{monogram(player.id)}</span>
        <div className="pod-names">
          <strong>{player.id}</strong>
          <span>{usd(player.chips)}</span>
        </div>
        {picked ? <span className="pick-tag" title="Your pick">★</span> : null}
      </div>
      <div className="pod-cards">
        {player.holeCards?.length ? (
          player.holeCards.map((card, index) => (
            <CardView key={`${card.rank}${card.suit}${index}`} card={card} compact dealDelay={index * 80} />
          ))
        ) : (
          <>
            <div className="card-back" />
            <div className="card-back" />
          </>
        )}
      </div>
      {folded ? <span className="pod-status">folded</span> : null}
      {pool > 0 ? <span className="pod-pool">{usd(pool)} backed</span> : null}
    </div>
  )
}

function MyBetResult({ bets }: { bets: SpectatorBet[] }) {
  if (!bets.length) return null
  const net = bets.reduce((sum, b) => sum + (b.status === 'won' ? b.amount * (b.multiplier - 1) : -b.amount), 0)
  if (net > 0) return <p className="my-result won">You called it — +{usd(net)}</p>
  if (net < 0) return <p className="my-result lost">Not this time — {usd(net)}</p>
  return <p className="my-result">Break even</p>
}

function CardView({ card, compact = false, dealDelay = 0 }: { card: Card; compact?: boolean; dealDelay?: number }) {
  const red = card.suit === 'h' || card.suit === 'd'
  return (
    <div
      className={`playing-card ${compact ? 'compact' : ''} ${red ? 'red' : ''}`}
      style={dealDelay ? { animationDelay: `${dealDelay}ms` } : undefined}
    >
      <span className="pc-rank">{RANKS[card.rank] ?? card.rank}</span>
      <span className="pc-suit">{SUITS[card.suit]}</span>
    </div>
  )
}

function monogram(id: string): string {
  return id
    .split(/[-_\s]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

const ACTION_VERBS: Record<string, (amount: number) => string> = {
  fold: () => 'folds',
  check: () => 'checks',
  call: (amount) => (amount > 0 ? `calls ${usd(amount)}` : 'calls'),
  raise: (amount) => `raises to ${usd(amount)}`,
  allin: () => 'goes all in',
}

function host(): string {
  if (typeof window === 'undefined') return 'poker.100ai.id'
  return window.location.host
}

function describeEvent(event: TableEvent): string | null {
  const d = event.data
  switch (event.type) {
    case 'demo_started': {
      const players = (d.players as string[]) ?? []
      const openSeats = Number(d.openSeats ?? 0)
      if (openSeats > 0) {
        return `Match opening: ${players.length ? players.join(', ') + ' seated, ' : ''}${openSeats} guest seat${openSeats === 1 ? '' : 's'} open`
      }
      return `New match: ${players.join(' vs ')}`
    }
    case 'match_starting':
      return `Table full — ${(d.players as string[]).join(' vs ')} starting`
    case 'timeout':
      return `${d.playerId} ran out of time — auto-${d.action}`
    case 'house_filling':
      return `House bots step in: ${(d.players as string[]).join(', ')}`
    case 'player_joined':
      return `${d.playerId} sits down`
    case 'hand_start':
      return `Hand #${d.handNumber} begins`
    case 'blind':
      return `${d.playerId} posts ${usd(Number(d.amount))}`
    case 'deal':
      return `${capitalize(String(d.street))}: ${((d.board as Card[]) ?? []).map(cardLabel).join(' ')}`
    case 'action': {
      const verb = ACTION_VERBS[String(d.action)]
      return verb ? `${d.playerId} ${verb(Number(d.amount) || 0)}` : `${d.playerId} ${d.action}`
    }
    case 'showdown':
      return `Showdown — ${((d.hands as { playerId: string; handName: string }[]) ?? [])
        .map((hand) => `${hand.playerId}: ${hand.handName}`)
        .join(', ')}`
    case 'hand_end': {
      const result = d.result as { winners: { playerId: string; amount: number; handName?: string }[] }
      return result.winners
        .map((w) => `${w.playerId} wins ${usd(w.amount)}${w.handName ? ` with ${w.handName}` : ''}`)
        .join(', ')
    }
    case 'chat':
      return `${d.playerId}: “${d.say}”`
    case 'thought':
      return `${d.playerId} is thinking it over…`
    case 'payout':
      return `${d.playerId} cashes out ${d.amount}`
    case 'settling':
      return 'Match over — paying out'
    case 'settled':
      return 'All chips paid out'
    case 'bet_placed':
      return `Someone put ${d.amount} on ${d.agentId}`
    case 'bet_won':
      return `A backer collected ${d.amount} on ${d.agentId}`
    case 'bets_refunded':
      return 'Open bets refunded'
    default:
      return null
  }
}

function cardLabel(card: Card): string {
  return `${RANKS[card.rank] ?? card.rank}${SUITS[card.suit]}`
}

function usd(chips: number): string {
  const dollars = chips / 1e6
  return `${dollars < 0 ? '-' : ''}$${Math.abs(dollars).toFixed(2)}`
}
