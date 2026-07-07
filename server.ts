import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import next from 'next'
import { SERVER_PORT } from './src/config.js'
import { openWallet } from './src/payments/wallet.js'
import { createTableApp } from './src/server/app.js'

const dev = process.env.NODE_ENV !== 'production'
const hostname = '0.0.0.0'
const port = SERVER_PORT

const nextApp = next({ dev, hostname, port })
const nextHandler = nextApp.getRequestHandler()

const treasury = await openWallet('treasury', '.wallets/treasury.json')
console.log(`[server] treasury: ${treasury.address}`)
const { app: tableApp } = createTableApp(treasury)

await nextApp.prepare()

http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', requestOrigin(req)).pathname
    if (path === '/api/health' || path.startsWith('/api/table')) {
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
