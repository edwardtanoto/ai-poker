# CLAUDE.md

Read [AGENTS.md](AGENTS.md) — it is the architecture guide, invariants list,
and extension roadmap for this repo. Follow it.

Quick rules:
- Chips are integer pathUSD base units; keep the zero-sum invariant and the
  engine fuzz test green (`npm test`).
- Engine (`src/engine/`) stays pure — no I/O, no payments.
- mppx/tempo integration facts are documented in AGENTS.md § Payments — they
  were verified against the installed SDK; don't guess replacements.
- Secrets: `.env` + `.wallets/` are gitignored. Never log or commit keys.
- Verify payment/agent changes with a real short testnet game:
  `PORT=4031 MAX_HANDS=3 npm run server` then
  `SERVER_URL=http://localhost:4031 npm run demo`.
