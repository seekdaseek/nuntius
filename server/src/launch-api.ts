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
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
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
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getTokenSize,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
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
import { commitmentSentence, FeedBus, feedFromDb, parseOwnWallets, registerFeedRoutes } from './launch-feed.js'
import { readMetadataUri, TokenImages } from './token-image.js'
import { readTokenTrust, type TokenTrust } from './token-trust.js'
import { priceInQuote, UsdPrices } from './launch-market.js'
import { getRecurringDelegationCodec, getSubscriptionAuthorityCodec } from '@solana/subscriptions'

/** The base fee per signature; a back grant has one, the backer's. */
const LAMPORTS_PER_SIGNATURE = 5_000n

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** The web backing page's files (static/l), served by name only. */
const PAGE_ASSETS = new Set([
  'backing.js',
  'backing.css',
  'BricolageGrotesque_800ExtraBold.ttf',
  'Figtree_400Regular.ttf',
  'og-card.png',
  'Figtree_600SemiBold.ttf',
  'OFL-bricolage.txt',
  'OFL-figtree.txt',
])
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
  /** What the web backing page is told: this server's executor, cluster and tokens. */
  page?: { cluster: string; mints: { symbol: string; mint: string; decimals: number; maxPerPeriodUi: string }[] }
  /** Where static/l lives (tests point it at the repository's own). */
  staticDir?: string
  /** Token images for the backing page's header (token-image.ts); built from conn and origin when absent. */
  images?: TokenImages
  /** The quote tokens' USD prices (launch-market.ts); Jupiter's, cached, when absent. */
  usd?: UsdPrices
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
  const staticDir = d.staticDir ?? path.join(import.meta.dirname, '..', 'static')
  const usd = d.usd ?? new UsdPrices()
  const images =
    d.images ??
    new TokenImages({
      origin: d.origin,
      launchImage: (mint) => d.mandates.launchByMint(mint)?.image ?? null,
      tokensDir: path.join(staticDir, 'tokens'),
      readUri: (mint) => readMetadataUri(d.conn, mint),
    })
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
  // Whose money backs a pool, in the one sentence the page and its link card both use
  // (commitmentSentence); a pool the feed does not list has no backers.
  const own = d.feed?.own ?? parseOwnWallets(undefined)
  const commitmentOf = (pool: string) =>
    feedFromDb(d.mandates.database, own).find((x) => x.pool === pool)?.commitment ??
    commitmentSentence({
      symbol: '',
      quoteSymbol: '',
      committedPerWeek: { thirdParty: '0', builder: '0' },
      backers: { all: 0, thirdParty: 0 },
    })
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
  const launchView = (
    L: Awaited<ReturnType<typeof readLaunch>>,
    symbol: string | null,
    image: string | null = null,
    trust: TokenTrust | null = null,
  ) => ({
    pool: L.pool,
    route: L.route,
    dammPool: L.dammPool,
    baseMint: L.baseMint,
    quoteMint: L.quoteMint,
    symbol,
    image,
    trust,
    progressPct: L.progressBps / 100,
    quoteRaised: L.quoteRaised,
    threshold: L.threshold,
    refusal: L.refusal,
    committed: demand(L.pool),
    commitment: commitmentOf(L.pool),
  })

  app.get('/api/launch/:pool', limitByIp(d.publicLimiter), (req, res) => {
    const pool = String(req.params.pool)
    if (!ADDRESS_RE.test(pool)) return void res.status(400).json({ ok: false, error: 'bad_pool' })
    readLaunch(d.conn, pool)
      .then(async (L) => {
        // The token's promises are read on every request, never cached: they are the page's claims.
        const quote = d.page?.mints.find((m) => m.mint === L.quoteMint) ?? null
        const [symbol, image, trust, quoteUsd] = await Promise.all([
          d.mandates.launchByPool(pool)?.symbol ??
            tokenInfo(d.conn, L.baseMint)
              .then((t) => t.symbol)
              .catch(() => null),
          images.imageOf(L.baseMint),
          readTokenTrust(d.conn, L.baseMint),
          quote ? usd.of(quote.mint) : Promise.resolve(null),
        ])
        // The market, after what only nuntius shows: price from the pool's own sqrt price, the
        // market cap from the mint's supply, both in the quote token; USD from Jupiter, cached.
        const priceQuote = quote ? priceInQuote(L, quote.decimals) : null
        const supply =
          trust.supply !== null && trust.decimals !== null ? Number(trust.supply) / 10 ** trust.decimals : null
        res.json({
          ok: true,
          launch: {
            ...launchView(L, symbol, image, trust),
            market: {
              priceQuote,
              quoteUsd,
              marketCapQuote: priceQuote !== null && supply !== null ? priceQuote * supply : null,
            },
            curve: curveShape(L),
          },
        })
      })
      .catch((e: unknown) =>
        e instanceof UnsupportedLaunch
          ? res.status(422).json({ ok: false, error: 'launch_unsupported', message: e.message })
          : res.status(404).json({ ok: false, error: 'no_launch', message: safeError(e) }),
      )
  })

  // The committed-demand feed for terminals: public and read-only (launch-feed.ts).
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

  // The web backing page: /l/<pool>, for any Wallet Standard wallet. The page is static; the
  // server writes in its own executor and tokens, which the page's transaction check uses.
  const pageDir = path.join(staticDir, 'l')
  let template: string | null = null
  // The Mobile Wallet Adapter's dialogs (Chrome on Android) style themselves with fixed <style>
  // blocks and two style attributes: allowed by hash only, as computed by web/build.mjs from the
  // bundled package. Their Google Fonts stylesheet stays blocked; they fall back to system fonts.
  const mwa = (() => {
    try {
      return JSON.parse(readFileSync(path.join(pageDir, 'mwa-csp.json'), 'utf8')) as {
        styles: string[]
        attributes: string[]
      }
    } catch {
      return null
    }
  })()
  const PAGE_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    mwa ? ["style-src 'self' 'unsafe-hashes'", ...mwa.styles, ...mwa.attributes].join(' ') : "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data: https:",
    // The Mobile Wallet Adapter's local association: http://localhost is the request that makes
    // Chrome ask for local network access, ws://localhost:* the socket to the phone's wallet.
    "connect-src 'self' ws://localhost:* http://localhost",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  // The page's script and stylesheet are content-addressed: backing.<hash>.js. The server keeps
  // the bytes it hashed and serves exactly those, so a name can never carry other content, even
  // while a deploy swaps files; they are cached for a year. A hash the file on disk no longer
  // has is a 404. Other assets carry a cache header only when the file was sent, and every
  // failure is a 404 nobody caches (app.ts).
  const built = new Map<string, { mtimeMs: number; size: number; bytes: Buffer; hash: string }>()
  const builtAsset = (file: 'backing.js' | 'backing.css' | 'og-card.png') => {
    const st = statSync(path.join(pageDir, file))
    const c = built.get(file)
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c
    const bytes = readFileSync(path.join(pageDir, file))
    const next = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      bytes,
      hash: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
    }
    built.set(file, next)
    return next
  }
  const assetNotFound = (res: express.Response) => res.status(404).json({ ok: false, error: 'not_found' })
  app.get('/l/assets/:file', (req, res) => {
    const file = String(req.params.file)
    // The link card too: X keeps a card for days, so a changed card must be a new URL. The plain
    // og-card.png stays for links already shared.
    const hashed = /^(backing\.([0-9a-f]{12})\.(js|css)|og-card\.([0-9a-f]{12})\.png)$/.exec(file)
    if (hashed) {
      const name = hashed[2] ? (`backing.${hashed[3]}` as 'backing.js' | 'backing.css') : 'og-card.png'
      let a: ReturnType<typeof builtAsset> | null = null
      try {
        a = builtAsset(name)
      } catch {
        a = null
      }
      if (!a || a.hash !== (hashed[2] ?? hashed[4])) return void assetNotFound(res)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const ext = (hashed[3] ?? 'png') as 'js' | 'css' | 'png'
      const type = { js: 'application/javascript', css: 'text/css', png: 'image/png' }[ext]
      return void res.type(type).send(a.bytes)
    }
    if (!PAGE_ASSETS.has(file)) return void assetNotFound(res)
    res.sendFile(path.join(pageDir, file), { maxAge: 300_000 }, (err) => {
      if (err && !res.headersSent) assetNotFound(res)
    })
  })
  // What a first back grant costs its signer: rent for the delegation, the subscription authority
  // and the backer's launch-token account (sizes from the programs' own layouts, rent read
  // from the chain), and the base fee. The wallet may add a priority fee on top. Read once; a
  // failed read leaves the page without the line rather than with a guess.
  let setupLamports: Promise<string | null> | null = null
  const setupCost = () =>
    (setupLamports ??= Promise.resolve()
      .then(() =>
        Promise.all(
          [getRecurringDelegationCodec().fixedSize, getSubscriptionAuthorityCodec().fixedSize, getTokenSize()].map(
            (n) => d.rpc.getMinimumBalanceForRentExemption(BigInt(n)).send(),
          ),
        ),
      )
      .then((rents) => (rents.reduce((a, b) => a + BigInt(b), 0n) + LAMPORTS_PER_SIGNATURE).toString())
      .catch(() => {
        setupLamports = null
        return null
      }))

  // A wallet's balance of one of this server's quote tokens, so the page can say "you need
  // SKR" before anyone signs. Public and read-only, like the chain it reads; mints are limited
  // to the ones this server pulls.
  app.get('/api/balance/:owner/:mint', limitByIp(d.publicLimiter), (req, res) => {
    const owner = String(req.params.owner)
    const mint = d.page?.mints.find((m) => m.mint === String(req.params.mint))
    if (!ADDRESS_RE.test(owner) || !mint) return void res.status(400).json({ ok: false, error: 'bad_request' })
    ataOf(owner, mint.mint)
      .then((ata) => readAta(d.rpc, ata as Address))
      .then((a) => res.json({ ok: true, amount: a.exists ? (a.amount ?? '0') : '0', decimals: mint.decimals }))
      .catch(() => res.status(502).json({ ok: false, error: 'chain_error' }))
  })

  app.get('/l/:pool', async (req, res) => {
    const pool = String(req.params.pool)
    if (!ADDRESS_RE.test(pool)) return void res.status(404).json({ ok: false, error: 'not_found' })
    // The script and stylesheet by their content hash, from the files in place when the
    // template is first built (after a deploy's swap, at the first request after the restart).
    template ??= readFileSync(path.join(pageDir, 'index.html'), 'utf8').replace(
      /\/l\/assets\/backing\.(js|css)"/g,
      (_m, ext: 'js' | 'css') => `/l/assets/backing.${builtAsset(`backing.${ext}`).hash}.${ext}"`,
    )
    const config = JSON.stringify({
      setupLamports: await setupCost(),
      executor: d.delegatee,
      cluster: d.page?.cluster ?? 'mainnet',
      mints: d.page?.mints ?? [],
      // v1.0.2, the Latest release, cannot back a launch: send Seeker owners to 1.1.0.
      apk: 'https://github.com/seekdaseek/nuntius/releases/tag/v1.1.0',
    }).replace(/</g, '\\u003c')
    res.setHeader('Content-Security-Policy', PAGE_CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', 'no-cache')
    // Link previews (X, Telegram): per launch, from the store, escaped; a fixed 1200x630 card.
    const f = feedFromDb(d.mandates.database, own).find((x) => x.pool === pool)
    const sym = f?.symbol || d.mandates.launchByPool(pool)?.symbol || 'a launch'
    const ogTitle = `Back ${sym} on nuntius`
    // Whose money it is, as the page says it (commitmentSentence); the second sentence is fixed.
    const ogDesc = `${(f?.commitment ?? commitmentOf(pool)).card} Capped recurring buys on Meteora: nothing deposited, revoke any time.`
    const esc = (t: string) =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    res.type('html').send(
      template
        .replace('__CONFIG__', config)
        .replaceAll('__OG_TITLE__', esc(ogTitle))
        .replaceAll('__OG_DESC__', esc(ogDesc))
        .replaceAll('__OG_URL__', esc(`${d.origin}/l/${pool}`))
        .replaceAll('__OG_IMAGE__', esc(`${d.origin}/l/assets/og-card.${builtAsset('og-card.png').hash}.png`)),
    )
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

/**
 * The curve's price path, from its own config: how many times the last token costs the first
 * (the migration sqrt price over the start one, squared) and where the price is now on that
 * scale. Null once the pool has left its curve.
 */
function curveShape(L: Awaited<ReturnType<typeof readLaunch>>): { priceRatio: number; nowRatio: number | null } | null {
  const cfg = L.raw.dbc?.config as unknown as
    { sqrtStartPrice?: { toString(): string }; migrationSqrtPrice?: { toString(): string } } | undefined
  const now = (L.raw.dbc?.pool as unknown as { poolState?: { sqrtPrice?: { toString(): string } } } | undefined)
    ?.poolState?.sqrtPrice
  const start = Number(cfg?.sqrtStartPrice?.toString() ?? 0)
  const end = Number(cfg?.migrationSqrtPrice?.toString() ?? 0)
  if (L.route !== 'dbc' || !(start > 0) || !(end > start)) return null
  return { priceRatio: (end / start) ** 2, nowRatio: now ? (Number(now.toString()) / start) ** 2 : null }
}

export const _forTests = { tokenInfo, parseUnits }
export type { Mandate }
