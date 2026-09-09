import { randomBytes } from 'node:crypto'
import express from 'express'
import type { Config } from './config'
import type { Store } from './db'
import { buildPayload, NONCE_RE, parseSignInResult, verifySiws } from './siws'
import { checkWalletForSgt } from './seeker'

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function createApp(config: Config, store: Store): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '8kb' }))

  app.get('/api/siws-payload', (_req, res) => {
    const payload = buildPayload(config.domain, Date.now())
    store.issueNonce(payload)
    res.json({ ok: true, payload })
  })

  app.post('/api/siws-verify', (req, res) => {
    const body: unknown = req.body
    const nonce = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).nonce : undefined
    const signInResult =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>).signInResult : undefined

    // Shape checks come first: a malformed request must not burn a valid nonce.
    const parsed = parseSignInResult(signInResult)
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce) || !parsed) {
      res.status(400).json({ ok: false, error: 'bad_request' })
      return
    }

    // 1. The nonce must be one this server issued, unexpired and unused. Consuming it is atomic.
    const payload = store.consumeNonce(nonce, Date.now())
    if (!payload) {
      res.status(401).json({ ok: false, error: 'nonce_invalid' })
      return
    }

    // 2. Signature, then 3. domain binding — both verified against the stored payload only.
    const result = verifySiws(payload, config.domain, parsed)
    if (!result.ok) {
      res.status(401).json({ ok: false, error: result.error })
      return
    }

    const session = randomBytes(32).toString('base64url')
    store.createSession(session, result.address, Date.now())
    res.json({ ok: true, address: result.address, session })
  })

  app.post('/api/verify-seeker', (req, res) => {
    const body: unknown = req.body
    const session = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).session : undefined
    if (typeof session !== 'string' || !SESSION_TOKEN_RE.test(session)) {
      res.status(400).json({ ok: false, error: 'bad_request' })
      return
    }

    // The wallet address comes from the verified session, never from the request body.
    const address = store.getSessionAddress(session)
    if (!address) {
      res.status(401).json({ ok: false, error: 'session_invalid' })
      return
    }

    if (!config.heliusRpc) {
      res.status(503).json({ ok: false, error: 'not_configured' })
      return
    }

    checkWalletForSgt(config.heliusRpc, address)
      .then((sgtMint) => {
        if (sgtMint) store.claimSgtMint(session, sgtMint)
        res.json({ ok: true, sgtMint })
      })
      .catch(() => {
        // Fail closed and say nothing about the RPC target.
        res.status(502).json({ ok: false, error: 'rpc_error' })
      })
  })

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' })
  })

  // Uniform JSON errors: the default Express handler prints an HTML stack trace
  // with filesystem paths. Malformed JSON and anything unexpected land here.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 413 ? 413 : 400
    res.status(status).json({ ok: false, error: 'bad_request' })
  })

  return app
}
