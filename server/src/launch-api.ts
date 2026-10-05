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
  type MeteoraConnection,
} from './meteora.js'
import { buildGrantTx, readAta, readRecurring, userAtaOf } from './mandate-chain.js'
import { describeBacking, formatUnits, parseUnits } from './mandate-text.js'
import type { Mandate, MandateStore } from './mandate-store.js'
import type { Rpc } from './tx.js'
import { limitByIp, type RateLimiter } from './rate-limit.js'
import { safeError } from './log.js'
import { CLIENT_HEADER, clientAtLeast } from './client-version.js'

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SYMBOL_RE = /^[A-Z0-9]{2,10}$/
const NAME_RE = /^[\p{L}\p{N} .'&-]{1,32}$/u

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
      throw new HttpError(400, 'bad_pool', safeError(e))
    }
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
    const quote = d.parseTerms(
      { symbol: body.quote, amount: '1', period: 'week', untilDays: 1, payee: d.delegatee },
      a.address,
    ).mint
    // The curve migrates once this much quote is raised. Small on purpose: a launch backed by
    // a few people's weekly buys should reach its regular pool.
    const thresholdUi = quote.symbol === 'SKR' ? 50_000 : 1_000
    const config = await generateKeyPairSigner()
    const baseMint = await generateKeyPairSigner()
    const pool = dbcPoolAddress(quote.mint, baseMint.address, config.address)
    const uri = `${d.origin}/m/${baseMint.address}.json`
    const ixs = await launchInstructions(d.conn, {
      creator: a.address,
      quoteMint: quote.mint,
      quoteThreshold: thresholdUi,
      name,
      symbol,
      uri,
      config: config.address,
      baseMint: baseMint.address,
    })
    // The two new keys sign here; the creator (fee payer) is left for the device.
    const withSigners = ixs.map((ix) => ({
      ...ix,
      accounts: ix.accounts?.map((acc) =>
        acc.address === config.address
          ? { ...acc, signer: config }
          : acc.address === baseMint.address
            ? { ...acc, signer: baseMint }
            : acc,
      ),
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
        config: config.address,
        creator: a.address,
        name,
        symbol,
        image,
        quoteMint: quote.mint,
      },
      d.now(),
    )
    return { transactionBase64: getBase64EncodedWireTransaction(signed), pool, baseMint: baseMint.address, uri }
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
      .catch((e: unknown) => res.status(404).json({ ok: false, error: 'no_launch', message: safeError(e) }))
  })

  app.get('/m/:file', (req, res) => {
    const mint = String(req.params.file).replace(/\.json$/, '')
    const l = ADDRESS_RE.test(mint) ? d.mandates.launchByMint(mint) : null
    if (!l) return void res.status(404).json({ ok: false, error: 'not_found' })
    res.json({
      name: l.name,
      symbol: l.symbol,
      image: l.image,
      description: `${l.name}: a subscription launch on nuntius. Backed by capped weekly buys, approved once in Seed Vault.`,
    })
  })
}

export const _forTests = { tokenInfo, parseUnits }
export type { Mandate }
