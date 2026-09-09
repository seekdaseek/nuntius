import { randomBytes } from 'node:crypto'
import express from 'express'
import type { Config } from './config'
import type { Store } from './db'
import { buildPayload, NONCE_RE, parseSignInResult, verifySiws } from './siws'
import { checkWalletForSgt } from './seeker'
import { forwardRpc, parseRpcRequest } from './rpc-proxy'
import type { FcmSender } from './fcm'

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
// FCM registration tokens: instance id, a colon, then a URL-safe blob.
const PUSH_TOKEN_RE = /^[A-Za-z0-9_:.-]{20,4096}$/

export function createApp(config: Config, store: Store, fcm: FcmSender | null): express.Express {
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
    const auth = store.getSession(session)
    if (!auth) {
      res.status(401).json({ ok: false, error: 'session_invalid' })
      return
    }

    if (!config.heliusRpc) {
      res.status(503).json({ ok: false, error: 'not_configured' })
      return
    }

    checkWalletForSgt(config.heliusRpc, auth.address)
      .then((sgtMint) => {
        if (sgtMint) store.claimSgtMint(session, sgtMint)
        res.json({ ok: true, sgtMint })
      })
      .catch(() => {
        // Fail closed and say nothing about the RPC target.
        res.status(502).json({ ok: false, error: 'rpc_error' })
      })
  })

  app.post('/api/push/register', (req, res) => {
    const body: unknown = req.body
    const v = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    const session = typeof v.session === 'string' && SESSION_TOKEN_RE.test(v.session) ? v.session : null
    const token = typeof v.token === 'string' && PUSH_TOKEN_RE.test(v.token) ? v.token : null
    const platform = v.platform === 'android' || v.platform === 'ios' ? v.platform : null
    if (!session || !token || !platform) {
      res.status(400).json({ ok: false, error: 'bad_request' })
      return
    }

    // Session-gated: an open registration endpoint would let anyone attach a
    // token to any wallet. The token binds to the session's own identity only.
    const auth = store.getSession(session)
    if (!auth) {
      res.status(401).json({ ok: false, error: 'session_invalid' })
      return
    }

    store.upsertPushToken(token, auth.address, auth.sgtMint, platform, Date.now())
    res.json({ ok: true })
  })

  app.post('/api/push/test', (req, res) => {
    const body: unknown = req.body
    const v = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    const session = typeof v.session === 'string' && SESSION_TOKEN_RE.test(v.session) ? v.session : null
    if (!session) {
      res.status(400).json({ ok: false, error: 'bad_request' })
      return
    }

    const auth = store.getSession(session)
    if (!auth) {
      res.status(401).json({ ok: false, error: 'session_invalid' })
      return
    }

    if (!fcm) {
      res.status(503).json({ ok: false, error: 'not_configured' })
      return
    }

    // Only the caller's own tokens — this endpoint cannot address anyone else's device.
    const tokens = store.getPushTokens(auth.address)
    if (tokens.length === 0) {
      res.status(404).json({ ok: false, error: 'no_push_tokens' })
      return
    }

    const sentAt = new Date().toISOString()
    Promise.all(
      tokens.map(async (token) => {
        const result = await fcm.send(
          token,
          { title: 'nuntius test', body: 'Push pipeline is live on this Seeker.' },
          'alerts',
          { url: `/alert?source=push-test&at=${encodeURIComponent(sentAt)}`, channelId: 'alerts' },
        )
        return { token: `${token.slice(0, 12)}…`, status: result.status, response: result.body }
      }),
    )
      .then((results) => res.json({ ok: true, results }))
      .catch(() => res.status(502).json({ ok: false, error: 'fcm_error' }))
  })

  app.post('/api/rpc', (req, res) => {
    const request = parseRpcRequest(req.body)
    if (!request) {
      res.status(400).json({ ok: false, error: 'bad_request' })
      return
    }
    if (!config.heliusRpc) {
      res.status(503).json({ ok: false, error: 'not_configured' })
      return
    }
    forwardRpc(config.heliusRpc, request)
      .then((result) => res.json(result))
      .catch(() => res.status(502).json({ ok: false, error: 'rpc_error' }))
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
