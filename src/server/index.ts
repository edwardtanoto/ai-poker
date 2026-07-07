import { serve } from '@hono/node-server'
import { SERVER_PORT } from '../config.js'
import { openWallet } from '../payments/wallet.js'
import { createTableApp } from './app.js'

const treasury = await openWallet('treasury', '.wallets/treasury.json')
console.log(`[server] treasury: ${treasury.address}`)

const { app } = createTableApp(treasury)

serve({ fetch: app.fetch, hostname: '0.0.0.0', port: SERVER_PORT }, (info) => {
  console.log(`[server] x402-poker table API listening on http://localhost:${info.port}`)
})
