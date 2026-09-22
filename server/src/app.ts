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
  buildInitAuthorityTx,
  buildRecurringDelegationTx,
  buildRevokeAuthorityTx,
  buildRevokeDelegationTx,
  devnetRpcUrl,
  executePull,
  mainnetRpcUrl,
  readAtaDelegate,
  readDelegation,
  ensureReceiverAta,
} from './delegation.js'
import type { TransactionSigner } from '@solana/kit'
import type { Address } from '@solana/kit'

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
// A pull amount is a whole number of base units, capped only by what u64 can hold.
const AMOUNT_RE = /^\d{1,20}$/

/**
 * Pull amount in base units. Absent means half the per-period cap, which is the
 * ordinary scheduled draw. An explicit value is passed through untouched — over
 * the cap included — because only the program may decide that.
 */
function parsePullAmount(value: unknown, capBaseUnits: bigint): bigint {
  if (value === undefined || value === null) return capBaseUnits / 2n
  const raw = typeof value === 'number' ? String(value) : value
  if (typeof raw !== 'string' || !AMOUNT_RE.test(raw)) throw new Error('amount must be a whole number of base units')
  const amount = BigInt(raw)
  if (amount === 0n) throw new Error('amount must be greater than zero')
  if (amount > 18_446_744_073_709_551_615n) throw new Error('amount exceeds u64')
  return amount
}
// FCM registration tokens: instance id, a colon, then a URL-safe blob.
const PUSH_TOKEN_RE = /^[A-Za-z0-9_:.-]{20,4096}$/

/** Base units rendered as a decimal string — `5000n` at 6 dp is `0.005`, not `0`. */
function formatUnits(baseUnits: bigint, decimals: number): string {
  if (decimals === 0) return baseUnits.toString()
  const negative = baseUnits < 0n
  const digits = (negative ? -baseUnits : baseUnits).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

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

  // --- Delegation. The device signs; the server never holds the user's key. ---

  /** Whichever cluster this deployment delegates on. Same program address either way. */
  function delegationRpcUrl(): string {
    return config.delegation.cluster === 'mainnet' ? mainnetRpcUrl(config.heliusRpc) : devnetRpcUrl(config.heliusRpc)
  }

  app.post('/api/delegation/setup', (req, res) => {
    const auth = requireAuth(req, res)
    if (!auth) return
    if (!delegation) {
      res.status(503).json({ ok: false, error: 'not_configured' })
      return
    }
    const { cluster, mint, capBaseUnits, periodLengthS, decimals } = config.delegation
    // Mainnet delegates against a mint the user already holds and creates nothing.
    // Devnet mints a throwaway token first, which is why only it needs a payer.
    const build =
      cluster === 'mainnet'
        ? buildInitAuthorityTx({
            rpcUrl: mainnetRpcUrl(config.heliusRpc),
            owner: auth.address as Address,
            mint: mint as Address,
            delegatee: delegation.delegatee.address,
            amountPerPeriod: capBaseUnits,
            periodLengthS,
          })
        : buildDelegationSetup({
            rpcUrl: devnetRpcUrl(config.heliusRpc),
            owner: auth.address as Address,
            payer: delegation.payer,
            delegatee: delegation.delegatee.address,
            amountPerPeriod: capBaseUnits,
            periodLengthS,
            decimals,
          })
    build
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
      rpcUrl: delegationRpcUrl(),
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
    const rpcUrl = delegationRpcUrl()
    // The caller may name an amount so an over-cap pull can be attempted through
    // the real path. There is deliberately NO cap check here: the program is what
    // rejects an over-cap transfer, and a refusal from this server would prove
    // nothing about the chain.
    let amount: bigint
    try {
      amount = parsePullAmount((req.body as { amount?: unknown }).amount, BigInt(row.amountPerPeriod))
    } catch (e) {
      res.status(400).json({ ok: false, error: e instanceof Error ? e.message : 'bad_amount' })
      return
    }
    ;(async () => {
      const receiverAta =
        row.receiverAta ??
        (await ensureReceiverAta({
          rpcUrl,
          // On mainnet the delegatee funds its own receiving account; there is no
          // server payer holding real SOL.
          payer: config.delegation.cluster === 'mainnet' ? delegation.delegatee : delegation.payer,
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
      const decimals = config.delegation.decimals
      const movedText = formatUnits(amount, decimals)
      const remainingText = formatUnits(remaining, decimals)
      const url =
        `/alert?source=delegation&sig=${signature}` +
        `&moved=${movedText}&remaining=${remainingText}&reset=${nextResetTs}&pda=${row.delegationPda}` +
        `&cluster=${config.delegation.cluster}`

      const tokens = store.getPushTokens(auth.address)
      const pushes = await Promise.all(
        tokens.map((t) =>
          fcm.send(
            t,
            {
              title: 'Delegated transfer executed',
              body: `${movedText} moved. ${remainingText} left this period.`,
            },
            'alerts',
            { url, channelId: 'alerts' },
          ),
        ),
      )
      return {
        signature,
        amount: movedText,
        amountBaseUnits: amount.toString(),
        remaining: remainingText,
        remainingBaseUnits: remaining.toString(),
        nextResetTs,
        pushes: pushes.map((p) => p.status),
      }
    })()
      .then((out) => res.json({ ok: true, ...out }))
      .catch((e: unknown) => {
        res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'pull_failed' })
      })
  })

  /**
   * Revocation, built for the device to sign. Two transactions, in this order:
   * closing the delegation PDA does not clear the SPL delegate, so a run that
   * stopped after the first would still leave the token account delegated.
   */
  app.post('/api/delegation/revoke-delegation', (req, res) => {
    const auth = requireAuth(req, res)
    if (!auth) return
    const row = store.getDelegation(auth.address)
    if (!row) {
      res.status(404).json({ ok: false, error: 'no_delegation' })
      return
    }
    buildRevokeDelegationTx({
      rpcUrl: delegationRpcUrl(),
      owner: auth.address as Address,
      delegationPda: row.delegationPda as Address,
    })
      .then((out) => res.json({ ok: true, ...out, delegationPda: row.delegationPda }))
      .catch((e: unknown) => {
        res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'revoke_delegation_failed' })
      })
  })

  app.post('/api/delegation/revoke-authority', (req, res) => {
    const auth = requireAuth(req, res)
    if (!auth) return
    const row = store.getDelegation(auth.address)
    if (!row) {
      res.status(404).json({ ok: false, error: 'no_delegation' })
      return
    }
    buildRevokeAuthorityTx({
      rpcUrl: delegationRpcUrl(),
      owner: auth.address as Address,
      mint: row.mint as Address,
    })
      .then((out) => res.json({ ok: true, ...out, userAta: row.userAta }))
      .catch((e: unknown) => {
        res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'revoke_authority_failed' })
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
    const rpcUrl = delegationRpcUrl()
    Promise.all([readDelegation(rpcUrl, row.delegationPda as Address), readAtaDelegate(rpcUrl, row.userAta as Address)])
      .then(([state, ata]) =>
        res.json({
          ok: true,
          cluster: config.delegation.cluster,
          delegationPda: row.delegationPda,
          mint: row.mint,
          userAta: row.userAta,
          userAtaDelegate: ata.delegate,
          userAtaDelegatedAmount: ata.delegatedAmount,
          userAtaBalance: ata.amount,
          ...state,
        }),
      )
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
