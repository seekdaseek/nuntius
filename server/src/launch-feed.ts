/**
 * The committed-demand feed: public, read-only numbers for trading terminals and for anyone
 * checking a launch. No other entry publishes recurring, capped, per-period demand.
 *
 *   GET /api/launches          every nuntius launch and every backed pool: route and curve
 *                              progress, committed demand per week, backers, buys executed,
 *                              volume, the latest buys
 *   GET /api/launches/stream   server-sent events: each buy and each migration as it lands
 *
 * Third-party numbers leave out the operator's own wallets (OWN_WALLETS: the treasury, the
 * test wallets and the executor); they are still listed, flagged own: true.
 */
import { EventEmitter } from 'node:events'
import type express from 'express'
import type Database from 'better-sqlite3'
import { formatUnits } from './mandate-text.js'
import { clientIp, limitByIp, type RateLimiter } from './rate-limit.js'
import type { LedgerEvent } from './digest.js'
import { buyJitterS } from './executor.js'

export const DEFAULT_OWN_WALLETS = [
  '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', // cj7, the treasury
  'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX', // natX, a test wallet
  '23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP', // the executor
]

/** What the chain says about a pool right now (readLaunch, cached by the caller). */
export interface PoolChain {
  route: 'dbc' | 'damm_v2' | 'migrating'
  dammPool: string | null
  progressPct: number
  quoteRaised: string
  threshold: string
}

export interface FeedBuy {
  at: number
  signature: string
  quoteIn: string
  baseOut: string | null
  own: boolean
  /** The backer's wallet: every buy lands in it, so it is public on chain anyway. */
  backer: string
}

/** A buy the executor will send: when, how much, for whom. */
export interface FeedNextBuy {
  at: number
  quoteIn: string
  own: boolean
  backer: string
}

export interface FeedPool {
  pool: string
  baseMint: string
  symbol: string
  quoteMint: string
  quoteSymbol: string
  /** Launched through nuntius on one of its configs, rather than an outside pool being backed. */
  launchedOnNuntius: boolean
  chain: PoolChain | null
  committedPerWeek: { all: string; thirdParty: string }
  backers: { all: number; thirdParty: number }
  buysExecuted: { all: number; thirdParty: number }
  volumeQuote: { all: string; thirdParty: string }
  lastBuys: FeedBuy[]
  /** The next scheduled buys, soonest first: each live backing's next period, at the executor's jitter. */
  nextBuys: FeedNextBuy[]
}

type Row = Record<string, unknown>

/** The feed's numbers, from the store alone (chain state is joined in by the route). */
export function feedFromDb(
  db: Database.Database,
  own: Set<string>,
  nowMs: number = Date.now(),
): Omit<FeedPool, 'chain'>[] {
  const launches = db.prepare("SELECT * FROM launches WHERE status = 'live'").all() as Row[]
  const backings = db
    .prepare(
      `SELECT b.pool, b.base_mint, b.base_symbol, m.id, m.address, m.mint, m.symbol, m.decimals,
              m.amount_per_period, m.period_length_s, m.status
         FROM backings b JOIN mandates m ON m.id = b.mandate_id
        WHERE m.status IN ('active', 'revoked', 'expired')`,
    )
    .all() as Row[]
  const buys = db
    .prepare(
      `SELECT b.pool, m.address, p.amount, p.signature, p.updated_at,
              (SELECT e.out_amount FROM events e WHERE e.signature = p.signature AND e.kind = 'buy') AS out_amount
         FROM pulls p JOIN backings b ON b.mandate_id = p.mandate_id JOIN mandates m ON m.id = p.mandate_id
        WHERE p.state = 'landed' ORDER BY p.updated_at DESC`,
    )
    .all() as Row[]

  const pools = new Map<
    string,
    Omit<FeedPool, 'chain'> & {
      _decimals: number
      _perWeek: bigint
      _perWeek3: bigint
      _vol: bigint
      _vol3: bigint
      _backers: Set<string>
    }
  >()
  const ensure = (pool: string, base: Partial<Omit<FeedPool, 'chain'>>, decimals: number) => {
    let p = pools.get(pool)
    if (!p) {
      p = {
        pool,
        baseMint: base.baseMint ?? '',
        symbol: base.symbol ?? '',
        quoteMint: base.quoteMint ?? '',
        quoteSymbol: base.quoteSymbol ?? '',
        launchedOnNuntius: false,
        committedPerWeek: { all: '0', thirdParty: '0' },
        backers: { all: 0, thirdParty: 0 },
        buysExecuted: { all: 0, thirdParty: 0 },
        volumeQuote: { all: '0', thirdParty: '0' },
        lastBuys: [],
        nextBuys: [],
        _decimals: decimals,
        _perWeek: 0n,
        _perWeek3: 0n,
        _vol: 0n,
        _vol3: 0n,
        _backers: new Set(),
      }
      pools.set(pool, p)
    }
    return p
  }
  for (const l of launches) {
    const p = ensure(
      String(l.pool),
      { baseMint: String(l.base_mint), symbol: String(l.symbol), quoteMint: String(l.quote_mint) },
      6,
    )
    p.launchedOnNuntius = true
  }
  for (const b of backings) {
    const p = ensure(
      String(b.pool),
      {
        baseMint: String(b.base_mint),
        symbol: String(b.base_symbol),
        quoteMint: String(b.mint),
        quoteSymbol: String(b.symbol),
      },
      Number(b.decimals),
    )
    if (!p.quoteSymbol) p.quoteSymbol = String(b.symbol)
    if (!p.quoteMint) p.quoteMint = String(b.mint)
    p._decimals = Number(b.decimals)
    if (b.status !== 'active') continue
    const perWeek = (BigInt(String(b.amount_per_period)) * 604_800n) / BigInt(Number(b.period_length_s))
    const address = String(b.address)
    p._perWeek += perWeek
    p._backers.add(address)
    if (!own.has(address)) p._perWeek3 += perWeek
  }
  for (const r of buys) {
    const p = pools.get(String(r.pool))
    if (!p) continue
    const amount = BigInt(String(r.amount))
    const isOwn = own.has(String(r.address))
    p.buysExecuted.all++
    p._vol += amount
    if (!isOwn) {
      p.buysExecuted.thirdParty++
      p._vol3 += amount
    }
    if (p.lastBuys.length < 10)
      p.lastBuys.push({
        at: Number(r.updated_at),
        signature: String(r.signature),
        quoteIn: formatUnits(amount, p._decimals),
        baseOut: r.out_amount == null ? null : String(r.out_amount),
        own: isOwn,
        backer: String(r.address),
      })
  }
  // The next buy of each live backing: the period after the last one the executor claimed (or
  // the current one when it has not claimed it yet), at the same jitter the executor uses.
  const live = db
    .prepare(
      `SELECT b.pool, m.id, m.address, m.amount_per_period, m.period_length_s, m.expiry_ts, m.activated_at, m.decimals,
              (SELECT MAX(p.period_start) FROM pulls p WHERE p.mandate_id = m.id) AS last_start
         FROM backings b JOIN mandates m ON m.id = b.mandate_id
        WHERE m.status = 'active'`,
    )
    .all() as Row[]
  const nowS = Math.floor(nowMs / 1000)
  for (const r of live) {
    const p = pools.get(String(r.pool))
    if (!p) continue
    const len = Number(r.period_length_s)
    const last = r.last_start == null ? null : Number(r.last_start)
    const start = last ?? Math.floor(Number(r.activated_at ?? 0) / 1000)
    if (!len || !start) continue
    const current = start + Math.max(0, Math.floor((nowS - start) / len)) * len
    const next = last !== null && current === last ? current + len : current
    const expiry = Number(r.expiry_ts ?? 0)
    if (expiry && next >= expiry) continue
    p.nextBuys.push({
      at: (next + buyJitterS(String(r.id), next, len)) * 1000,
      quoteIn: formatUnits(BigInt(String(r.amount_per_period)), Number(r.decimals)),
      own: own.has(String(r.address)),
      backer: String(r.address),
    })
  }
  for (const p of pools.values()) {
    p.nextBuys.sort((a, b) => a.at - b.at)
    p.nextBuys.splice(5)
  }
  return [...pools.values()].map(({ _decimals, _perWeek, _perWeek3, _vol, _vol3, _backers, ...p }) => ({
    ...p,
    committedPerWeek: { all: formatUnits(_perWeek, _decimals), thirdParty: formatUnits(_perWeek3, _decimals) },
    backers: { all: _backers.size, thirdParty: [..._backers].filter((a) => !own.has(a)).length },
    volumeQuote: { all: formatUnits(_vol, _decimals), thirdParty: formatUnits(_vol3, _decimals) },
  }))
}

/** One feed event: a buy or a migration, as it lands. */
export interface FeedEvent {
  kind: 'buy' | 'migrated'
  at: number
  pool: string
  signature: string
  symbol: string | null
  quoteIn: string | null
  baseOut: string | null
  own: boolean
}

/** The in-process channel the receipts publish to and the stream listens on. */
export class FeedBus extends EventEmitter {
  private readonly migrated = new Set<string>()
  constructor(
    private readonly db: Database.Database,
    private readonly own: Set<string>,
  ) {
    super()
    this.setMaxListeners(200)
  }

  /** Called for every receipt recorded for the first time. */
  fromReceipt(address: string, e: LedgerEvent): void {
    if (e.kind !== 'buy' && e.kind !== 'migrated') return
    const r = this.db
      .prepare('SELECT b.pool FROM backings b JOIN mandates m ON m.id = b.mandate_id WHERE m.delegation_pda = ?')
      .get(e.delegationPda) as { pool: string } | undefined
    if (!r) return
    const signature = e.kind === 'migrated' ? (e.note ?? '') : (e.signature ?? '')
    // One migration event per pool, however many backers got its receipt.
    if (e.kind === 'migrated') {
      if (this.migrated.has(r.pool)) return
      this.migrated.add(r.pool)
    }
    const event: FeedEvent = {
      kind: e.kind,
      at: e.at,
      pool: r.pool,
      signature,
      symbol: e.outSymbol ?? null,
      quoteIn: e.kind === 'buy' && e.amountBaseUnits ? formatUnits(BigInt(e.amountBaseUnits), e.decimals) : null,
      baseOut: e.kind === 'buy' ? (e.outBaseUnits ?? null) : null,
      own: this.own.has(address),
    }
    this.emit('event', event)
  }
}

export function registerFeedRoutes(
  app: express.Express,
  d: {
    db: Database.Database
    own: Set<string>
    bus: FeedBus
    chain: (pool: string) => Promise<PoolChain | null>
    limiter: RateLimiter
    maxStreams?: number
    maxStreamsPerIp?: number
    heartbeatMs?: number
  },
): void {
  const maxStreams = d.maxStreams ?? 100
  const maxPerIp = d.maxStreamsPerIp ?? 3
  const cache = new Map<string, { at: number; value: PoolChain | null }>()
  const chainOf = async (pool: string) => {
    const c = cache.get(pool)
    if (c && Date.now() - c.at < 30_000) return c.value
    const value = await d.chain(pool).catch(() => c?.value ?? null)
    cache.set(pool, { at: Date.now(), value })
    return value
  }

  app.get('/api/launches', limitByIp(d.limiter), (_req, res) => {
    const rows = feedFromDb(d.db, d.own)
    Promise.all(rows.map(async (r) => ({ ...r, chain: await chainOf(r.pool) })))
      .then((launches) => {
        res.setHeader('Cache-Control', 'public, max-age=15')
        res.json({ ok: true, asOf: new Date().toISOString(), ownWallets: [...d.own], launches })
      })
      .catch(() => res.status(502).json({ ok: false, error: 'chain_error' }))
  })

  const open = new Map<string, number>()
  let total = 0
  app.get('/api/launches/stream', (req, res) => {
    const ip = clientIp(req)
    if (total >= maxStreams || (open.get(ip) ?? 0) >= maxPerIp)
      return void res.status(429).json({ ok: false, error: 'too_many_streams' })
    total++
    open.set(ip, (open.get(ip) ?? 0) + 1)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`event: hello\ndata: ${JSON.stringify({ kinds: ['buy', 'migrated'] })}\n\n`)
    const onEvent = (e: FeedEvent) => res.write(`event: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`)
    d.bus.on('event', onEvent)
    const beat = setInterval(() => res.write(': keep-alive\n\n'), d.heartbeatMs ?? 25_000)
    req.on('close', () => {
      clearInterval(beat)
      d.bus.off('event', onEvent)
      total--
      const n = (open.get(ip) ?? 1) - 1
      if (n > 0) open.set(ip, n)
      else open.delete(ip)
    })
  })
}

export function parseOwnWallets(raw: string | undefined): Set<string> {
  const list = raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_OWN_WALLETS
  return new Set(list)
}
