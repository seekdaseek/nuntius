/**
 * Subscription launches (Meteora DBC) over HTTP:
 *
 *   POST /api/mandates/back   a back permission: the grant, plus the backer's own token
 *                             account for the launch token, in one transaction
 *   POST /api/launch/create   a DBC config + pool in one transaction: the server signs with
 *                             the fresh config and mint keys, the device signs once
 *   POST /api/launch/confirm  the pool exists on chain: the launch is live
 *   GET  /api/launch/:pool    public, read-only: curve progress, route, committed demand
 *   GET  /m/:mint.json        the launch token's metadata JSON (its on-chain URI)
 *
 * Launching is for verified Seeker owners only (the SGT tier), so a launch is one device.
 */
import type express from 'express'
import {
  createNoopSigner,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import { getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import {
  ataOf,
  dbcPoolAddress,
  DEFAULT_SLIPPAGE_BPS,
  launchInstructions,
  readLaunch,
  tokenInfo as readTokenInfo,
  UnsupportedLaunch,
  type MeteoraConnection,
} from './meteora.js'
import { buildGrantTx, readAta, readRecurring, userAtaOf } from './mandate-chain.js'
import { describeBacking, formatUnits, parseUnits } from './mandate-text.js'
import type { Mandate, MandateStore } from './mandate-store.js'
import type { Rpc } from './tx.js'
import { limitByIp, type RateLimiter } from './rate-limit.js'
import { safeError } from './log.js'
import { CLIENT_HEADER, clientAtLeast } from './client-version.js'
import { FeedBus, parseOwnWallets, registerFeedRoutes } from './launch-feed.js'

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SYMBOL_RE = /^[A-Z0-9]{2,10}$/
const NAME_RE = /^[\p{L}\p{N} .'&-]{1,32}$/u
/** A launch's own description: plain words and punctuation, no markup, no line breaks. */
const DESCRIPTION_RE = /^[\p{L}\p{N} .,;:'’&()!?%$+/-]{1,200}$/u

/** What nuntius earns from a launch on its config, in one plain line (shown before signing). */
export const FEES_LINE = 'nuntius earns 0.4% of curve trades and half of the locked pool’s fees after graduation.'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

export interface LaunchDeps {
  mandates: MandateStore
  rpc: Rpc
  conn: MeteoraConnection
  delegatee: Address
  /** https://<domain>: where /m/<mint>.json is served. */
  origin: string
  auth: (body: Record<string, unknown>) => { address: string; tier: string }
  /** The same validation as a pay permission, with the executor as the "payee". */
  parseTerms: (
    body: Record<string, unknown>,
    owner: string,
  ) => {
    label: string
    mint: { mint: string; symbol: string; decimals: number }
    amount: bigint
    periodLengthS: number
    expiryTs: number
  }
  gate: (a: { address: string; tier: string }) => void
  freshNonce: () => number
  publicLimiter: RateLimiter
  now: () => number
  /** nuntius's fixed partner config per quote symbol (mandate-config.ts launchConfigs). */
  launchConfigs: Record<string, string>
  /** The public feed's bus and own wallets; without them the feed serves numbers and a quiet stream. */
  feed?: { bus: FeedBus; own: Set<string> }
}

/** The launch token's decimals and symbol, from its mint and Metaplex metadata accounts. */
async function tokenInfo(conn: MeteoraConnection, mint: string): Promise<{ decimals: number; symbol: string }> {
  const t = await readTokenInfo(conn, mint)
  if (!t) throw new HttpError(400, 'bad_launch', 'the launch token has no mint account')
  return t
}

/** The extra instruction a back grant carries: the backer creates their own account for the launch token. */
export async function backerAccountInstruction(
  owner: string,
  baseMint: string,
): Promise<{ ata: string; ix: Instruction }> {
  const ata = await ataOf(owner, baseMint)
  const payer = createNoopSigner(owner as Address)
  return {
    ata,
    ix: getCreateAssociatedTokenIdempotentInstruction({
      payer,
      ata: ata as Address,
      owner: owner as Address,
      mint: baseMint as Address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
  }
}

export function registerLaunchRoutes(app: express.Express, d: LaunchDeps): void {
  // An app older than 1.1.0 (no x-nuntius-client header, as v1.0.2 sends) falls through to
  // the 404 it gets when launches are off: the same answer, byte for byte.
  const route = (path: string, handler: (body: Record<string, unknown>) => Promise<object>) => {
    app.post(path, (req, res, next) => {
      if (!clientAtLeast(req.get(CLIENT_HEADER))) return next()
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      handler(body)
        .then((out) => res.json({ ok: true, ...out }))
        .catch((e: unknown) => {
          const he = e instanceof HttpError ? e : (e as { status?: number; code?: string; message?: string })
          if (typeof he.status === 'number' && typeof he.code === 'string')
            res.status(he.status).json({ ok: false, error: he.code, message: he.message })
          else res.status(502).json({ ok: false, error: 'chain_error', message: safeError(e) })
        })
    })
  }

  const backerAccountIx = backerAccountInstruction

  route('/api/mandates/back', async (body) => {
    const a = d.auth(body)
    d.gate(a)
    const pool = typeof body.pool === 'string' ? body.pool.trim() : ''
    if (!ADDRESS_RE.test(pool)) throw new HttpError(400, 'bad_pool', 'pool must be a Meteora DBC pool address')
    let L: Awaited<ReturnType<typeof readLaunch>>
    try {
      L = await readLaunch(d.conn, pool)
    } catch (e) {
      if (e instanceof UnsupportedLaunch) throw new HttpError(400, 'launch_unsupported', e.message)
      throw new HttpError(400, 'bad_pool', safeError(e))
    }
    if (L.refusal) throw new HttpError(400, 'launch_unsupported', L.refusal)
    const t = d.parseTerms({ ...body, payee: d.delegatee }, a.address)
    if (L.quoteMint !== t.mint.mint)
      throw new HttpError(400, 'launch_other_token', `this launch is priced in another token, not ${t.mint.symbol}`)
    // The pull lands in the executor's own account for the quote token and the swap empties
    // it in the same transaction; that account must exist before the first buy.
    const receiverAta = await userAtaOf(d.delegatee, t.mint.mint as Address)
    const r = await readAta(d.rpc, receiverAta)
    if (!r.exists || r.owner !== d.delegatee)
      throw new HttpError(
        503,
        'executor_not_ready',
        `nuntius has no ${t.mint.symbol} account yet: back permissions open once it does`,
      )
    const base = await tokenInfo(d.conn, L.baseMint)
    const { ata: backerBaseAta, ix } = await backerAccountIx(a.address, L.baseMint)
    const userAta = await userAtaOf(a.address as Address, t.mint.mint as Address)
    let nonce = 0
    let grant: Awaited<ReturnType<typeof buildGrantTx>> | null = null
    for (let attempt = 0; attempt < 3 && !grant; attempt++) {
      nonce = d.freshNonce()
      const g = await buildGrantTx(
        d.rpc,
        {
          owner: a.address as Address,
          mint: t.mint.mint as Address,
          delegatee: d.delegatee,
          nonce: BigInt(nonce),
          amountPerPeriod: t.amount,
          periodLengthS: BigInt(t.periodLengthS),
          startTs: 0n,
          expiryTs: BigInt(t.expiryTs),
        },
        [ix],
      )
      if (!(await readRecurring(d.rpc, g.delegationPda)).exists && !d.mandates.getMandateByPda(g.delegationPda))
        grant = g
    }
    if (!grant) throw new HttpError(503, 'no_fresh_seed', 'Could not pick a fresh permission address. Try again.')
    const label = t.label || `Back ${base.symbol}`
    const m = d.mandates.insertMandate(
      {
        address: a.address,
        label,
        payee: d.delegatee,
        receiverAta,
        mint: t.mint.mint,
        symbol: t.mint.symbol,
        decimals: t.mint.decimals,
        amountPerPeriod: t.amount.toString(),
        pullAmount: t.amount.toString(),
        periodLengthS: t.periodLengthS,
        expiryTs: t.expiryTs,
        nonce,
        delegatee: d.delegatee,
        delegationPda: grant.delegationPda,
        authorityPda: grant.authorityPda,
        userAta,
      },
      d.now(),
    )
    d.mandates.setBacking({
      mandateId: m.id,
      pool,
      route: L.route === 'damm_v2' ? 'damm_v2' : 'dbc',
      dammPool: L.dammPool,
      baseMint: L.baseMint,
      baseSymbol: base.symbol,
      baseDecimals: base.decimals,
      backerBaseAta,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    })
    return {
      mandateId: m.id,
      transactionBase64: grant.transactionBase64,
      delegationPda: grant.delegationPda,
      createsAuthority: grant.createsAuthority,
      allowanceTotal: grant.allowance === null ? null : formatUnits(grant.allowance, t.mint.decimals),
      text: describeBacking({
        label,
        payee: d.delegatee,
        amountBaseUnits: t.amount,
        decimals: t.mint.decimals,
        symbol: t.mint.symbol,
        periodLengthS: t.periodLengthS,
        expiryTs: t.expiryTs,
        baseSymbol: base.symbol,
        slippagePct: DEFAULT_SLIPPAGE_BPS / 100,
      }),
      launch: launchView(L, null),
    }
  })

  route('/api/launch/create', async (body) => {
    const a = d.auth(body)
    if (a.tier !== 'seeker')
      throw new HttpError(403, 'seeker_only', 'Launching needs a verified Seeker (Seeker Genesis Token).')
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : ''
    if (!NAME_RE.test(name)) throw new HttpError(400, 'bad_name', 'name: 1–32 letters, digits, spaces')
    if (!SYMBOL_RE.test(symbol)) throw new HttpError(400, 'bad_symbol', 'symbol: 2–10 capital letters or digits')
    const image =
      typeof body.image === 'string' && /^https:\/\/[^\s"<>]{1,200}$/.test(body.image)
        ? body.image
        : `${d.origin}/identity-icon-192.png`
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    if (description && !DESCRIPTION_RE.test(description))
      throw new HttpError(400, 'bad_description', 'description: up to 200 characters of plain text')
    const quote = d.parseTerms(
      { symbol: body.quote, amount: '1', period: 'week', untilDays: 1, payee: d.delegatee },
      a.address,
    ).mint
    // Every launch in a quote is a pool on nuntius's one config for it: the curve, the fees
    // and the migration threshold are the config's, the same for every launch.
    const config = d.launchConfigs[quote.symbol]
    if (!config)
      throw new HttpError(
        503,
        'launch_not_ready',
        `Launches priced in ${quote.symbol} open once nuntius has its config.`,
      )
    const baseMint = await generateKeyPairSigner()
    const pool = dbcPoolAddress(quote.mint, baseMint.address, config)
    const uri = `${d.origin}/m/${baseMint.address}.json`
    const ixs = await launchInstructions(d.conn, {
      creator: a.address,
      config,
      name,
      symbol,
      uri,
      baseMint: baseMint.address,
    })
    // The fresh mint key signs here; the creator (fee payer) is left for the device.
    const withSigners = ixs.map((ix) => ({
      ...ix,
      accounts: ix.accounts?.map((acc) => (acc.address === baseMint.address ? { ...acc, signer: baseMint } : acc)),
    })) as Instruction[]
    const { value } = await d.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
    const creator = createNoopSigner(a.address as Address) as TransactionSigner
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(creator, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(value, m),
      (m) => appendTransactionMessageInstructions(withSigners, m),
    )
    const signed = await partiallySignTransactionMessageWithSigners(msg)
    d.mandates.addLaunch(
      {
        baseMint: baseMint.address,
        pool,
        config,
        creator: a.address,
        name,
        symbol,
        image,
        quoteMint: quote.mint,
        description: description || null,
      },
      d.now(),
    )
    return {
      transactionBase64: getBase64EncodedWireTransaction(signed),
      pool,
      baseMint: baseMint.address,
      config,
      uri,
      fees: FEES_LINE,
    }
  })

  route('/api/launch/confirm', async (body) => {
    d.auth(body)
    const mint = typeof body.baseMint === 'string' ? body.baseMint : ''
    const l = d.mandates.launchByMint(mint)
    if (!l) throw new HttpError(404, 'no_launch')
    try {
      const L = await readLaunch(d.conn, l.pool)
      d.mandates.setLaunchLive(mint)
      return { launch: launchView(L, l.symbol) }
    } catch {
      throw new HttpError(409, 'not_on_chain_yet', 'the launch has not landed yet')
    }
  })

  /** Committed recurring demand: every active backing's cap, per week. */
  const demand = (pool: string) => {
    const rows = d.mandates.backingsOfPool(pool)
    let perWeek = 0n
    for (const r of rows) perWeek += (BigInt(r.amountPerPeriod) * 604_800n) / BigInt(r.periodLengthS)
    const decimals = rows[0]?.decimals ?? 6
    return {
      backers: new Set(rows.map((r) => r.address)).size,
      perWeek: formatUnits(perWeek, decimals),
      symbol: rows[0]?.symbol ?? null,
    }
  }
  const launchView = (L: Awaited<ReturnType<typeof readLaunch>>, symbol: string | null) => ({
    pool: L.pool,
    route: L.route,
    dammPool: L.dammPool,
    baseMint: L.baseMint,
    quoteMint: L.quoteMint,
    symbol,
    progressPct: L.progressBps / 100,
    quoteRaised: L.quoteRaised,
    threshold: L.threshold,
    refusal: L.refusal,
    committed: demand(L.pool),
  })

  app.get('/api/launch/:pool', limitByIp(d.publicLimiter), (req, res) => {
    const pool = String(req.params.pool)
    if (!ADDRESS_RE.test(pool)) return void res.status(400).json({ ok: false, error: 'bad_pool' })
    readLaunch(d.conn, pool)
      .then(async (L) => {
        const symbol =
          d.mandates.launchByPool(pool)?.symbol ??
          (await tokenInfo(d.conn, L.baseMint).catch(() => null))?.symbol ??
          null
        res.json({ ok: true, launch: launchView(L, symbol) })
      })
      .catch((e: unknown) =>
        e instanceof UnsupportedLaunch
          ? res.status(422).json({ ok: false, error: 'launch_unsupported', message: e.message })
          : res.status(404).json({ ok: false, error: 'no_launch', message: safeError(e) }),
      )
  })

  // The committed-demand feed for terminals: public and read-only (launch-feed.ts).
  const own = d.feed?.own ?? parseOwnWallets(undefined)
  registerFeedRoutes(app, {
    db: d.mandates.database,
    own,
    bus: d.feed?.bus ?? new FeedBus(d.mandates.database, own),
    chain: async (pool) => {
      const L = await readLaunch(d.conn, pool)
      return {
        route: L.route,
        dammPool: L.dammPool,
        progressPct: L.progressBps / 100,
        quoteRaised: L.quoteRaised,
        threshold: L.threshold,
      }
    },
    limiter: d.publicLimiter,
  })

  app.get('/m/:file', (req, res) => {
    const mint = String(req.params.file).replace(/\.json$/, '')
    const l = ADDRESS_RE.test(mint) ? d.mandates.launchByMint(mint) : null
    if (!l) return void res.status(404).json({ ok: false, error: 'not_found' })
    // Served exactly as stored at launch: the on-chain URI never changes, and neither does this.
    res.json({
      name: l.name,
      symbol: l.symbol,
      image: l.image,
      description:
        l.description ??
        `${l.name}: a subscription launch on nuntius. Backed by capped weekly buys, approved once in Seed Vault.`,
    })
  })
}

export const _forTests = { tokenInfo, parseUnits }
export type { Mandate }
