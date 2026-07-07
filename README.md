# ♠ x402-poker

AI agents play no-limit Texas Hold'em against each other — and every buy-in and
cash-out is a **real machine-to-machine payment** over the
[Machine Payments Protocol (MPP)](https://mpp.dev), the HTTP 402 standard from
Stripe + Tempo (backwards-compatible with x402). Payments settle on-chain in
pathUSD on Tempo testnet.

```
agent wallet ──402 challenge──▶ table server
     │  signs Tempo charge credential  │
     └──────── paid, seated ──────────▶│  plays hands…
                                       │
     ◀──── TIP-20 payout tx ───────────┘  game over, cash out
```

## How it works

1. **Buy-in (MPP charge)** — `POST /api/table/join` is gated by `mppx` Hono
   middleware. The server answers with `402 Payment Required` + a Tempo charge
   challenge. The agent's payment-aware fetch (from `mppx/client`) signs a
   credential with its wallet, the payment settles on-chain to the table
   treasury, and the request retries through — the agent is seated with a
   $10 stack.
2. **Play** — chips at the table are pathUSD base units, backed 1:1 by the
   escrowed buy-ins. Agents poll for their turn and act
   (fold/check/call/raise/all-in). Full engine: side pots, min-raise rules,
   showdown with 7-card evaluation.
3. **Cash-out** — when one agent has all the chips (or the hand cap hits),
   the treasury pays each remaining stack back to its owner's wallet as an
   on-chain pathUSD transfer. Tx hashes appear in the log and UI.

Everything is funded by the Tempo testnet faucet automatically — fresh wallets
are created and topped up on first run, zero manual setup.

## Run it

```bash
npm install

# terminal 1 — the table
npm run server          # http://localhost:4021 (spectator UI)

# terminal 2 — seat two agents and play
npm run demo
```

## LLM players

Set `ANTHROPIC_API_KEY` and the agents become real LLM poker players:

```bash
ANTHROPIC_API_KEY=sk-... npm run demo
```

- **Personas** ([src/agents/personas.ts](src/agents/personas.ts)) — each seat
  has a distinct style: `ace-bot` (tight-aggressive math grinder), `river-rat`
  (loose trickster), `bluff-machine` (maniac), `tilt-proof` (calm GTO).
- **Thinking** — decisions use Claude's adaptive thinking; the summarized
  reasoning streams to the spectator UI (🧠), never to opponents.
- **Table talk** — agents can trash-talk (💬), and talk is public: opponents
  see it in their game history and can be manipulated by it. Bluffing in both
  actions and words is explicitly part of the prompt.
- **Memory** — every agent maintains a running history of blinds, actions,
  showdowns, results and chat, and is told to model opponents from it.
- **Structured decisions** — the model returns a JSON-schema-validated
  action (`fold/check/call/raise/allin` + raise size), clamped to the legal
  action set so a wild output can never crash a hand.

| Env | Default | Meaning |
|---|---|---|
| `POKER_MODEL` | `claude-opus-4-8` | Model for agent decisions |
| `POKER_EFFORT` | `low` | Thinking effort per decision (`low`/`medium`/`high`) — raise for stronger, slower play |

Without a key, agents fall back to a built-in rule-based strategy so the
payment demo still runs end-to-end.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `BUY_IN_USD` | `10` | Buy-in charged via MPP on join, in pathUSD |
| `SMALL_BLIND` / `BIG_BLIND` | `0.1` / `0.2` | Blinds in pathUSD |
| `TABLE_SEATS` | `2` | Players needed to start (2–4 supported) |
| `MAX_HANDS` | `20` | Hand cap before forced settlement |
| `PORT` | `4021` | Server port |
| `TEMPO_RPC_URL` | moderato RPC | Tempo testnet RPC |
| `MPP_SECRET_KEY` | random | HMAC key for stateless MPP challenges |

## API

- `POST /api/table/join` — **402-gated.** Body `{ playerId, address }` → `{ token }`
- `GET  /api/table` — public state; add `x-player-token` for hole cards + legal actions
- `POST /api/table/act` — `{ type: 'fold'|'check'|'call'|'raise'|'allin', amount? }`
- `GET  /api/table/events` — SSE stream (hands, actions, payments, payouts)
- `GET  /api/table/log` — full event history
- `GET  /` — spectator UI

## Layout

```
src/engine/    pure hold'em engine (deck, evaluator, betting, side pots) + tests
src/payments/  wallet: key persistence, faucet autofunding, pathUSD transfers
src/server/    Hono app, mppx 402 middleware, table lifecycle, SSE
src/agents/    autonomous players: mppx client wallet + Claude/rule brain
src/demo.ts    seats N agents against a running server
```

`npm test` runs the engine test suite (hand rankings, betting rules, side
pots, chip-conservation fuzz).

## Notes

- Wallet private keys persist in `.wallets/` (gitignored). Testnet only —
  don't reuse these keys anywhere real.
- One table per server process for the MVP; restart the server for a fresh game.
- Next steps in [PLAN.md](PLAN.md): MPP `session` intent for per-bet streaming
  micropayments, multiple tables, mainnet USDC.
