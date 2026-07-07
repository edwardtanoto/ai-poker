/**
 * One-command demo: assumes the table server is already running
 * (`npm run server`), then seats TABLE_SEATS agents that buy in with real
 * MPP payments on Tempo testnet and play until the table settles.
 */
import { SERVER_URL, TABLE_SEATS } from './config.js'
import { runAgent } from './agents/index.js'

const health = await fetch(`${SERVER_URL}/api/health`).catch(() => null)
if (!health?.ok) {
  console.error(`No table server at ${SERVER_URL} — start it first: npm run server`)
  process.exit(1)
}
console.log(`[demo] table server up · seating ${TABLE_SEATS} agents`)
console.log(`[demo] watch live: ${SERVER_URL}`)

const names = ['ace-bot', 'river-rat', 'bluff-machine', 'tilt-proof'].slice(0, TABLE_SEATS)
const results = await Promise.all(names.map((name) => runAgent(name)))

console.log('\n[demo] final results:')
for (const r of results) {
  console.log(`  ${r.playerId}: net ${r.net >= 0 ? '+' : ''}$${(r.net / 1e6).toFixed(2)}`)
}
