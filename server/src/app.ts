import { randomBytes } from 'node:crypto'
import express from 'express'
import type { Config } from './config.js'
import type { Store } from './db.js'
import { buildPayload, NONCE_RE, parseSignInResult, verifySiws } from './siws.js'
import { checkWalletForSgt } from './seeker.js'
import { forwardRpc, parseRpcRequest } from './rpc-proxy.js'
import type { FcmSender } from './fcm.js'
import {
  buildDelegationSetup,
  buildRecurringDelegationTx,
  devnetRpcUrl,
  executePull,
  readDelegation,
  ensureReceiverAta,
} from './delegation.js'
import type { TransactionSigner } from '@solana/kit'
import type { Address } from '@solana/kit'

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
// FCM registration tokens: instance id, a colon, then a URL-safe blob.
const PUSH_TOKEN_RE = /^[A-Za-z0-9_:.-]{20,4096}$/

/** Spike parameters: small cap, short period, so a reset is observable live. */
const SPIKE_DECIMALS = 6
const SPIKE_CAP = 100n * 10n ** BigInt(SPIKE_DECIMALS)
const SPIKE_PERIOD_S = 60n

export function createApp(
  config: Config,
  store: Store,
  fcm: FcmSender | null,
  delegation?: { payer: TransactionSigner; delegatee: TransactionSigner },
): express.Express {
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

  /** Session-gated helper: resolves the caller's wallet or ends the response. */
  const requireAuth = (req: express.Request, res: express.Response): { address: string } | null => {
    const v = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {}
    const session = typeof v.session === 'string' && SESSION_TOKEN_RE.test(v.session) ? v.session : null
    if (!session) {
      res.status(400).json({ ok: false, error: 'bad_request' })
      return null
    }
    const auth = store.getSession(session)
    if (!auth) {
      res.status(401).json({ ok: false, error: 'session_invalid' })
      return null
    }
    return auth
  }

  // --- Delegation spike (devnet). The device signs; the server never holds the user's key. ---

  app.post('/api/delegation/setup', (req, res) => {
    const auth = requireAuth(req, res)
    if (!auth) return
    if (!delegation) {
      res.status(503).json({ ok: false, error: 'not_configured' })
      return
    }
    buildDelegationSetup({
      rpcUrl: devnetRpcUrl(config.heliusRpc),
      owner: auth.address as Address,
      payer: delegation.payer,
      delegatee: delegation.delegatee.address,
      amountPerPeriod: SPIKE_CAP,
      periodLengthS: SPIKE_PERIOD_S,
      decimals: SPIKE_DECIMALS,
    })
      .then((setup) => {
        store.upsertDelegation(
          {
            delegationPda: setup.delegationPda,
            address: auth.address,
            mint: setup.mint,
            userAta: setup.userAta,
            authorityPda: setup.authorityPda,
            delegatee: setup.delegatee,
            amountPerPeriod: setup.amountPerPeriod,
            periodLengthS: setup.periodLengthS,
          },
          Date.now(),
        )
        res.json({ ok: true, ...setup })
      })
      .catch((e: unknown) => {
        res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'setup_failed' })
      })
  })

  app.post('/api/delegation/create', (req, res) => {
    const auth = requireAuth(req, res)
    if (!auth) return
    const row = store.getDelegation(auth.address)
    if (!row) {
      res.status(404).json({ ok: false, error: 'no_delegation_setup' })
      return
    }
    buildRecurringDelegationTx({
      rpcUrl: devnetRpcUrl(config.heliusRpc),
      owner: auth.address as Address,
      mint: row.mint as Address,
      delegatee: row.delegatee as Address,
      amountPerPeriod: BigInt(row.amountPerPeriod),
      periodLengthS: BigInt(row.periodLengthS),
    })
      .then((out) => res.json({ ok: true, ...out }))
      .catch((e: unknown) => {
        res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'create_failed' })
      })
  })

  /** Executes one delegated pull, then pushes. This is the money path: the user is asleep. */
  app.post('/api/delegation/pull', (req, res) => {
    const auth = requireAuth(req, res)
    if (!auth) return
    if (!delegation || !fcm) {
      res.status(503).json({ ok: false, error: 'not_configured' })
      return
    }
    const row = store.getDelegation(auth.address)
    if (!row) {
      res.status(404).json({ ok: false, error: 'no_delegation' })
      return
    }
    const rpcUrl = devnetRpcUrl(config.heliusRpc)
    const amount = BigInt(row.amountPerPeriod) / 2n
    ;(async () => {
      const receiverAta =
        row.receiverAta ??
        (await ensureReceiverAta({
          rpcUrl,
          payer: delegation.payer,
          mint: row.mint as Address,
          owner: delegation.delegatee.address,
        }))
      if (!row.receiverAta) store.setReceiverAta(row.delegationPda, receiverAta)

      const signature = await executePull({
        rpcUrl,
        delegatee: delegation.delegatee,
        delegationPda: row.delegationPda as Address,
        delegator: row.address as Address,
        delegatorAta: row.userAta as Address,
        receiverAta: receiverAta as Address,
        mint: row.mint as Address,
        amount,
      })

      // Read the post-transfer state straight off the chain — the push carries
      // evidence, never a number we merely believe.
      const state = await readDelegation(rpcUrl, row.delegationPda as Address)
      const remaining =
        state.exists && state.amountPerPeriod && state.amountPulledInPeriod
          ? BigInt(state.amountPerPeriod) - BigInt(state.amountPulledInPeriod)
          : 0n
      const nextResetTs =
        state.exists && state.currentPeriodStartTs && state.periodLengthS
          ? state.currentPeriodStartTs + state.periodLengthS
          : 0
      const unit = 10n ** BigInt(SPIKE_DECIMALS)
      const url =
        `/alert?source=delegation&sig=${signature}` +
        `&moved=${amount / unit}&remaining=${remaining / unit}&reset=${nextResetTs}&pda=${row.delegationPda}`

      const tokens = store.getPushTokens(auth.address)
      const pushes = await Promise.all(
        tokens.map((t) =>
          fcm.send(
            t,
            {
              title: 'Delegated transfer executed',
              body: `${amount / unit} tokens moved. ${remaining / unit} left this period.`,
            },
            'alerts',
            { url, channelId: 'alerts' },
          ),
        ),
      )
      return {
        signature,
        amount: (amount / unit).toString(),
        remaining: (remaining / unit).toString(),
        nextResetTs,
        pushes: pushes.map((p) => p.status),
      }
    })()
      .then((out) => res.json({ ok: true, ...out }))
      .catch((e: unknown) => {
        res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'pull_failed' })
      })
  })

  app.post('/api/delegation/state', (req, res) => {
    const auth = requireAuth(req, res)
    if (!auth) return
    const row = store.getDelegation(auth.address)
    if (!row) {
      res.status(404).json({ ok: false, error: 'no_delegation' })
      return
    }
    readDelegation(devnetRpcUrl(config.heliusRpc), row.delegationPda as Address)
      .then((state) => res.json({ ok: true, delegationPda: row.delegationPda, mint: row.mint, ...state }))
      .catch((e: unknown) => {
        res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'state_failed' })
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
