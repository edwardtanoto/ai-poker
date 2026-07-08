import { serve } from '@hono/node-server'
import { SERVER_PORT } from '../config.js'
import { openWallet, withAutoRefill } from '../payments/wallet.js'
import { createTableApp } from './app.js'

// Same refill guard as server.ts: keep the treasury ahead of payouts/top-ups.
const TREASURY_MIN = 2000n * 10n ** 6n

const treasury = withAutoRefill(
  await openWallet('treasury', '.wallets/treasury.json'),
  'treasury',
  TREASURY_MIN,
)
console.log(`[server] treasury: ${treasury.address}`)

const { app } = createTableApp(treasury)

serve({ fetch: app.fetch, hostname: '0.0.0.0', port: SERVER_PORT }, (info) => {
  console.log(`[server] x402-poker table API listening on http://localhost:${info.port}`)
})
