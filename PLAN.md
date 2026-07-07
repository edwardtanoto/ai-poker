# x402-poker — MVP Plan

AI agents play Texas Hold'em against each other, with real machine-to-machine
payments over the [Machine Payments Protocol (MPP)](https://mpp.dev) — the
HTTP 402 standard co-authored by Stripe and Tempo (backwards-compatible with x402).

## How money flows

Poker follows the classic casino model: **buy-in escrow → table chips → cash-out**.

1. **Buy-in (MPP charge)** — An agent joins a table by calling
   `POST /tables/:id/join`. The server responds `402 Payment Required` with an
   MPP challenge (Tempo `charge` intent, pathUSD on Tempo testnet). The agent's
   payment-aware fetch signs a credential, pays on-chain, retries, and gets
   seated. The buy-in lands in the table treasury wallet.
2. **Betting** — Bets within hands move table chips (backed 1:1 by the escrowed
   buy-ins). No per-bet on-chain traffic; every action is recorded in the hand
   log alongside the buy-in receipts.
3. **Cash-out (on-chain payout)** — When the game ends (one agent has all the
   chips, or hand limit reached), the treasury pays each remaining stack back
   to its owner's wallet as a TIP-20 pathUSD transfer. Transaction hashes are
   published in the game log.

## Components

| Piece | Tech | Role |
|---|---|---|
| `src/engine/` | pure TypeScript | Texas Hold'em: deck, 7-card evaluator, betting rounds, side pots, showdown |
| `src/server/` | Hono + `mppx/hono` | Table lifecycle, MPP-gated join, action API, SSE spectator stream, payouts |
| `src/agents/` | `mppx/client` + viem | Autonomous players: fresh wallet, testnet faucet autofund, 402 autopay, decision brain |
| `src/agents/brain` | Claude API or rules | `ANTHROPIC_API_KEY` set → Claude decides; otherwise rule-based bot |
| `public/` | vanilla HTML/JS | Spectator view over SSE: table, cards, stacks, payment events |

## Network

- Chain: Tempo testnet "moderato" (chainId 42431, RPC `https://rpc.moderato.tempo.xyz`)
- Currency: pathUSD `0x20c0000000000000000000000000000000000000` (6 decimals)
- Funding: programmatic faucet (`viem/tempo` `Actions.faucet.fund`) — every demo
  run can start from brand-new wallets, zero manual setup.

## MVP scope

- 2–4 agents per table, no-limit hold'em, fixed blinds
- Game ends when one player holds all chips or `MAX_HANDS` reached
- Payments real on testnet; hand history + receipts queryable via API

## Out of scope (later)

- Per-bet MPP session streaming (MPP `session` intent is the natural fit)
- Multiple concurrent tables / matchmaking, tournaments
- Mainnet USDC, rake, spectator betting
