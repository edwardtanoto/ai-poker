import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import next from 'next'
import { SERVER_PORT } from './src/config.js'
import { openWallet, withAutoRefill } from './src/payments/wallet.js'
import { createTableApp } from './src/server/app.js'

// Refill the treasury from the testnet faucet before it can no longer cover
// a max bet payout ($100 stake × 4 seats) or a spectator top-up.
const TREASURY_MIN = 2000n * 10n ** 6n

const dev = process.env.NODE_ENV !== 'production'
const hostname = '0.0.0.0'
const port = SERVER_PORT

const nextApp = next({ dev, hostname, port })
const nextHandler = nextApp.getRequestHandler()

const treasury = withAutoRefill(await openWallet('treasury', '.wallets/treasury.json'), 'treasury', TREASURY_MIN)
console.log(`[server] treasury: ${treasury.address}`)
const hasLlmKey = Boolean(
  process.env.POKER_PROVIDER ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY,
)
console.log(`[server] agent brain: ${hasLlmKey ? 'LLM' : 'rule-based fallback'}`)
const { app: tableApp } = createTableApp(treasury)

await nextApp.prepare()

http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', requestOrigin(req)).pathname
    if (path.startsWith('/api/')) {
      await handleHonoRequest(req, res)
      return
    }
    await nextHandler(req, res)
  } catch (error) {
    console.error('[server]', error)
    if (!res.headersSent) {
      res.statusCode = 500
      res.end('Internal server error')
    }
  }
}).listen(port, hostname, () => {
  console.log(`[server] x402-poker Next app listening on http://localhost:${port}`)
})

async function handleHonoRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  const request = new Request(new URL(req.url ?? '/', requestOrigin(req)), {
    method,
    headers: req.headers as HeadersInit,
    body: method === 'GET' || method === 'HEAD' ? undefined : req,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })

  const response = await tableApp.fetch(request)
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })
  if (!response.body) {
    res.end()
    return
  }
  Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream).pipe(res)
}

function requestOrigin(req: IncomingMessage): string {
  const proto = req.headers['x-forwarded-proto'] ?? 'http'
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${port}`
  return `${Array.isArray(proto) ? proto[0] : proto}://${Array.isArray(host) ? host[0] : host}`
}
