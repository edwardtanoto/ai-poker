# AGENTS.md — architecture & build guide for x402-poker

Read this before changing anything. It explains what exists, why it's shaped
this way, the invariants you must not break, and where to plug in new work.

## What this is

AI agents play no-limit Texas Hold'em against each other. Buy-ins and
cash-outs are **real machine-to-machine payments** over the
[Machine Payments Protocol (MPP)](https://mpp.dev) — the HTTP 402 standard
from Stripe + Tempo, x402-compatible — settled in pathUSD on Tempo testnet.

```
┌──────────── agent process (one per player) ────────────┐
│ viem wallet ── mppx client (auto-pays 402) ── brain     │
│  (faucet-funded)        │                (Claude/rules) │
└─────────────────────────┼───────────────────────────────┘
                          │ HTTP
┌─────────────────────────▼───────────────────────────────┐
│ table server (Hono, one table per process)              │
│  mppx 402 middleware → join (buy-in escrow to treasury) │
│  Table (game lifecycle) → Hand (engine, per-hand FSM)   │
│  SSE event stream → spectator UI (public/index.html)    │
│  settle → treasury sends TIP-20 payouts on-chain        │
└──────────────────────────────────────────────────────────┘
```

## Money model (the load-bearing design decision)

Casino model: **escrow in → table chips → cash out**. Per-bet on-chain
transfers would be slow and noisy; instead:

1. **Buy-in** — `POST /api/table/join` is gated by mppx Hono middleware.
   The 402 challenge is a Tempo `charge` for `BUY_IN_USD` paid to the
   treasury wallet. Handler only runs after on-chain verification.
2. **Chips = pathUSD base units** (6 decimals; 1 chip = 1e-6 pathUSD,
   `CHIP_SCALE` in `src/config.ts`). All engine amounts are integer chips.
   `formatUsd()` renders them. Never use floats for chip math.
3. **Cash-out** — on settle, treasury sends each surviving stack to its
   owner's wallet (`Actions.token.transferSync`, tx hash recorded).

**Invariant: zero-sum.** Sum of stacks after any hand == sum before
(fuzz-tested). Sum of payouts == sum of buy-ins. If you touch the engine or
settlement, keep the chip-conservation test green and add cases.

## Module map

| Path | What | Rules |
|---|---|---|
| `src/config.ts` | env config + tiny `.env` loader + chip units | Imported first everywhere; real env wins over `.env` |
| `src/engine/` | pure hold'em engine — no I/O, no payments | `cards.ts` deck/parse, `evaluator.ts` 7-card eval (packed-int scores), `hand.ts` betting FSM + side pots. Deterministic via injectable `random`. Keep pure — makes it fuzz-testable |
| `src/engine/engine.test.ts` | vitest: rankings, betting rules, side pots, 200-seed chip-conservation fuzz | Run `npm test` after any engine change |
| `src/payments/wallet.ts` | wallet open/persist (`.wallets/*.json`), faucet autofund, balance, send | Keys are testnet-only but gitignored; faucet gives ~1M pathUSD when balance < 100 |
| `src/server/table.ts` | `Table`: seats, hand lifecycle, event log + SSE fan-out, settlement | Emits every engine log entry as an event; `speak()` for chat/thought |
| `src/server/index.ts` | Hono app + mppx integration + static UI | One table per process; restart for fresh game |
| `src/agents/index.ts` | agent loop: wallet → 402 join → poll → decide → act; `GameMemory` builds prompt history from `/api/table/log` | Excludes opponents' `thought` events (mind-reading = cheating) |
| `src/agents/brain.ts` | `Brain` interface; `claudeBrain` (LLM) + `ruleBrain` (fallback) | LLM errors fall back to rules mid-game — never crash a turn |
| `src/agents/personas.ts` | per-seat playing styles for system prompts | Add personas here |
| `src/demo.ts` | seats `TABLE_SEATS` agents against a running server | |
| `public/index.html` | zero-dependency spectator UI over SSE | |

## HTTP API

- `POST /api/table/join` — **402-gated (MPP)**. Body `{playerId, address}` → `{token, seat}`
- `GET  /api/table` — public state; `x-player-token` header adds `you` (hole cards + `legalActions`)
- `POST /api/table/act` — `{type: fold|check|call|raise|allin, amount?}`; `amount` = raise-TO in chips, clamped
- `POST /api/table/say` — `{say?, thinking?}`; `say` → public `chat` event, `thinking` → spectator `thought` event
- `GET  /api/table/log` — full event array `{seq, time, type, data}`
- `GET  /api/table/events` — SSE of same events
- Auth = bearer-ish `x-player-token` issued at join. No signatures — MVP trust model.

## LLM brain contract

`Brain.decide(BrainInput) → { decision, say?, thinking? }`.

- Model default `claude-opus-4-8` (`POKER_MODEL` env), thinking effort
  `POKER_EFFORT` (default `low` for pace).
- Uses `client.messages.parse` + `zodOutputFormat` → structured
  `{action, raiseTo, say}`; `toLegalDecision()` clamps to the legal action
  set — **keep this clamp**, it's why a wild model output can't kill a hand.
- **Model capability gotcha**: Haiku 4.5 / Sonnet 4.5 reject
  `thinking: adaptive` and `effort` — `modelParams()` in brain.ts switches
  them to `{type:'enabled', budget_tokens}`. If you add models, check tier.
- Thinking summary is broadcast as `thought` (spectator-only by convention);
  `say` is public and enters opponents' history — talk manipulation is a
  deliberate game mechanic.

## Payments / mppx facts (verified against mppx@0.8.6 — don't re-derive)

- Server: `import { Mppx, tempo } from 'mppx/hono'`;
  `Mppx.create({ methods: [tempo.charge({testnet:true, currency, recipient})], secretKey })`;
  gate route with `mppx.charge({ amount: '10' })` (human units string).
- Receipt is attached to the response AFTER the handler runs — capture it via
  `mppx.onPaymentSuccess`, not from headers inside the handler.
- Client: `import { Mppx, tempo } from 'mppx/client'`;
  `Mppx.create({ methods: [tempo({ account })], polyfill: false }).fetch`
  auto-answers 402s.
- Chain: Tempo testnet "moderato", chainId 42431, RPC
  `https://rpc.moderato.tempo.xyz`. pathUSD `0x20c0…0000`, 6 decimals.
- Chain object: `import { tempoModerato } from 'viem/chains'` (NOT viem/tempo).
- Faucet: `import { Actions } from 'viem/tempo'; Actions.faucet.fund(client, {account})`
  — async, poll balance after.

## Env & secrets

- `.env` at repo root (gitignored, loaded by `src/config.ts`): `ANTHROPIC_API_KEY`.
- `.wallets/` holds generated private keys (gitignored, testnet only).
- Knobs: `BUY_IN_USD`, `SMALL_BLIND`, `BIG_BLIND`, `TABLE_SEATS` (2–4),
  `MAX_HANDS`, `PORT`, `SERVER_URL`, `TEMPO_RPC_URL`, `MPP_SECRET_KEY`,
  `POKER_MODEL`, `POKER_EFFORT`.
- **Never log or commit keys. Never put secrets in event log / prompts.**

## Commands

```bash
npm run server     # table + UI on :4021
npm run demo       # seat agents, play to settlement (needs running server)
npm run agent -- <name>   # one agent
npm test           # engine tests
npm run typecheck
# cheap test game:
PORT=4031 MAX_HANDS=3 npm run server   # then SERVER_URL=http://localhost:4031 npm run demo
```

## Testing conventions

- Engine changes: extend `engine.test.ts`; every betting-rule change needs a
  seeded deterministic test + must survive the fuzz loop.
- Payment/agent changes: run a real short game (commands above) — testnet is
  free and the faucet is automatic. Verify: buy-in tx debited, payout tx hash
  in log, zero-sum of nets across agents.
- UI changes: `.claude/launch.json` has `poker-server` for browser preview.

## Known limits / roadmap (good next tasks)

1. **Per-bet streaming payments** — MPP `session` intent (deposit + off-chain
   vouchers) fits per-action micropayments; replaces the chip escrow layer.
   See `mppx` tempo/session exports.
2. **Multiple tables / matchmaking** — `Table` is single-instance in
   `server/index.ts`; needs a registry keyed by table id + routes param.
3. **Auth hardening** — replace bearer token with wallet-signature auth
   (agent signs a nonce with its payout key).
4. **Rake** — `tempo.charge` supports `splits`; take table rake at buy-in.
5. **Tournaments, blind escalation** — blinds are static per table today.
6. **Mainnet** — swap chain/currency in config; buy-in becomes real USDC.
   Requires real key custody — do NOT reuse `.wallets/` scheme.

## Style

- TypeScript strict, ESM (`.js` import suffixes), 2-space, no default exports.
- Comments only for non-obvious constraints (see engine for tone).
- Chips are integers. Dollars only at the UI/prompt boundary via `formatUsd`.
