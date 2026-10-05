/**
 * Persistence for mandatum: mandates, the executor's pull ledger, the receipt
 * events every screen and push is built from, clock-ins and digest prefs.
 *
 * The pull ledger is the idempotency mechanism. One row per
 * (delegation, period start) with a UNIQUE constraint: the executor inserts the
 * row — carrying the signature it is ABOUT to send — before sending. A crash
 * after the insert is recovered by asking the chain about that signature, never
 * by building a second transfer for the same period.
 */
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EventKind, LedgerEvent } from './digest.js'

export type MandateStatus = 'pending' | 'active' | 'revoked' | 'expired'

export interface Mandate {
  id: string
  address: string
  label: string
  payee: string
  receiverAta: string
  mint: string
  symbol: string
  decimals: number
  amountPerPeriod: string
  pullAmount: string
  periodLengthS: number
  expiryTs: number
  nonce: number
  delegatee: string
  delegationPda: string
  authorityPda: string
  userAta: string
  status: MandateStatus
  createdAt: number
  activatedAt: number | null
  endedAt: number | null
}

/**
 * The chain's delegation carries exactly this permission's terms. Only then does
 * a pending permission become active: from the app's confirm, or from the guard
 * when the grant landed and the app never confirmed it.
 */
export function termsMatch(
  m: Mandate,
  d: {
    delegator?: string
    delegatee?: string
    mint?: string | null
    amountPerPeriod?: bigint | string | null
    periodLengthS?: bigint | number | null
    expiryTs?: bigint | number | null
  },
): boolean {
  if (d.amountPerPeriod == null || d.periodLengthS == null || d.expiryTs == null) return false
  return (
    d.delegator === m.address &&
    d.delegatee === m.delegatee &&
    d.mint === m.mint &&
    BigInt(d.amountPerPeriod) === BigInt(m.amountPerPeriod) &&
    BigInt(d.periodLengthS) === BigInt(m.periodLengthS) &&
    BigInt(d.expiryTs) === BigInt(m.expiryTs)
  )
}

/** The permission's window right after a receipt, in base units: what the meter draws. */
export interface EventWindow {
  remainingBaseUnits?: string
  capBaseUnits?: string
  nextResetTs?: number
  periodLengthS?: number
}

/** `skipped`: a buy whose swap missed its minimum-out; nothing moved, it may be tried again this period. */
export type PullState = 'signed' | 'landed' | 'refused' | 'failed' | 'skipped'

/** A `back` permission: each period's pull buys the launch's token for the backer. */
export interface Backing {
  mandateId: string
  /** The DBC pool of the launch; the route follows it to DAMM v2 after migration. */
  pool: string
  route: 'dbc' | 'damm_v2'
  dammPool: string | null
  baseMint: string
  baseSymbol: string
  baseDecimals: number
  /** The backer's own token account for the launch token, created by the backer in the grant. */
  backerBaseAta: string
  slippageBps: number
}

export interface PullRow {
  id: number
  mandateId: string
  delegationPda: string
  periodStart: number
  amount: string
  signature: string
  lastValidBlockHeight: string
  state: PullState
  attempts: number
  errorCode: number | null
  error: string | null
  nextAttemptAt: number
}

export function migrateMandates(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mandates (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      label TEXT NOT NULL,
      payee TEXT NOT NULL,
      receiver_ata TEXT NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      amount_per_period TEXT NOT NULL,
      pull_amount TEXT NOT NULL,
      period_length_s INTEGER NOT NULL,
      expiry_ts INTEGER NOT NULL,
      nonce INTEGER NOT NULL,
      delegatee TEXT NOT NULL,
      delegation_pda TEXT NOT NULL UNIQUE,
      authority_pda TEXT NOT NULL,
      user_ata TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mandates_address ON mandates (address, status);
    CREATE TABLE IF NOT EXISTS pulls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mandate_id TEXT NOT NULL,
      delegation_pda TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      amount TEXT NOT NULL,
      signature TEXT NOT NULL,
      last_valid_block_height TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      error_code INTEGER,
      error TEXT,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (delegation_pda, period_start)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL,
      delegation_pda TEXT NOT NULL,
      delegatee TEXT NOT NULL,
      label TEXT,
      amount TEXT,
      decimals INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      signature TEXT,
      actor TEXT NOT NULL,
      pushed INTEGER NOT NULL DEFAULT 0
    );
    -- A signature is one receipt, whichever path (executor or guard) saw it first.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_sig ON events (signature, kind) WHERE signature IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_events_address ON events (address, at);
    CREATE TABLE IF NOT EXISTS clock_ins (
      address TEXT NOT NULL,
      day TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (address, day)
    );
    CREATE TABLE IF NOT EXISTS digest_prefs (
      address TEXT PRIMARY KEY,
      hour INTEGER NOT NULL,
      tz_offset_min INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      last_sent_day TEXT
    );
    CREATE TABLE IF NOT EXISTS guard_cursor (
      delegation_pda TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      delegatee TEXT,
      mint TEXT,
      last_signature TEXT,
      seen_at INTEGER NOT NULL
    );
  `)
  // Receipts remember what was left right after them, so any receipt (not only
  // the push link) can draw the cap meter. Added in place on existing databases.
  const cols = new Set((db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name))
  for (const [name, type] of [
    ['remaining', 'TEXT'],
    ['cap', 'TEXT'],
    ['reset_ts', 'INTEGER'],
    ['period_s', 'INTEGER'],
  ] as const) {
    if (!cols.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`)
  }
  // When the digest hour was last chosen: a send time before it is not due.
  const prefCols = new Set(
    (db.prepare('PRAGMA table_info(digest_prefs)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!prefCols.has('saved_at')) db.exec('ALTER TABLE digest_prefs ADD COLUMN saved_at INTEGER')
  // When the last digest went out: the next one counts from there.
  if (!prefCols.has('last_sent_at')) db.exec('ALTER TABLE digest_prefs ADD COLUMN last_sent_at INTEGER')
  // Every receipt belongs to one permission (one mandate), not just to an address:
  // the same address can hold an earlier delegation account.
  if (!cols.has('mandate_id')) db.exec('ALTER TABLE events ADD COLUMN mandate_id TEXT')
  // Buys: what the backer received (launch token), next to what was paid (amount/symbol).
  for (const [name, type] of [
    ['out_amount', 'TEXT'],
    ['out_decimals', 'INTEGER'],
    ['out_symbol', 'TEXT'],
    // A skipped buy: why it was skipped.
    ['note', 'TEXT'],
  ] as const) {
    if (!cols.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`)
  }
  db.exec(`CREATE TABLE IF NOT EXISTS backings (
    mandate_id TEXT PRIMARY KEY,
    pool TEXT NOT NULL,
    route TEXT NOT NULL,
    damm_pool TEXT,
    base_mint TEXT NOT NULL,
    base_symbol TEXT NOT NULL,
    base_decimals INTEGER NOT NULL,
    backer_base_ata TEXT NOT NULL,
    slippage_bps INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_backings_pool ON backings (pool)')
  // Curves the executor's crank migrated to DAMM v2 (or found migrated): one row per pool,
  // claimed before the send, so two processes never send two migrations.
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    pool TEXT PRIMARY KEY,
    damm_pool TEXT NOT NULL,
    signature TEXT,
    state TEXT NOT NULL,
    cost_lamports TEXT,
    at INTEGER NOT NULL
  )`)
  // Subscription launches created in the app: the metadata JSON is served from here.
  db.exec(`CREATE TABLE IF NOT EXISTS launches (
    base_mint TEXT PRIMARY KEY,
    pool TEXT NOT NULL,
    config TEXT NOT NULL,
    creator TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    image TEXT NOT NULL,
    quote_mint TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_mandate ON events (mandate_id)')
  attributeEvents(db)
}

/**
 * Receipts are allowed this much before the mandate's row was created: the
 * row is written before the user signs, so a real grant or pull is always
 * after it, give or take clock differences between this server and the chain.
 */
export const RECEIPT_SKEW_MS = 60_000

/**
 * Gives existing receipts their mandate, and deletes receipts that come from
 * before the mandate at their address existed: rows the guard inserted from an
 * earlier delegation account at the same address (30 Sep, six pushes for 22 Sep
 * transactions). Idempotent; runs on every start.
 */
function attributeEvents(db: Database.Database): void {
  db.exec(`
    UPDATE events SET mandate_id = (
      SELECT m.id FROM mandates m
       WHERE m.delegation_pda = events.delegation_pda AND m.created_at <= events.at + ${RECEIPT_SKEW_MS}
       ORDER BY m.created_at DESC LIMIT 1)
     WHERE mandate_id IS NULL;
    DELETE FROM events
     WHERE mandate_id IS NULL
       AND EXISTS (SELECT 1 FROM mandates m WHERE m.delegation_pda = events.delegation_pda);
  `)
}

type Row = Record<string, unknown>
const toMandate = (r: Row): Mandate => ({
  id: String(r.id),
  address: String(r.address),
  label: String(r.label),
  payee: String(r.payee),
  receiverAta: String(r.receiver_ata),
  mint: String(r.mint),
  symbol: String(r.symbol),
  decimals: Number(r.decimals),
  amountPerPeriod: String(r.amount_per_period),
  pullAmount: String(r.pull_amount),
  periodLengthS: Number(r.period_length_s),
  expiryTs: Number(r.expiry_ts),
  nonce: Number(r.nonce),
  delegatee: String(r.delegatee),
  delegationPda: String(r.delegation_pda),
  authorityPda: String(r.authority_pda),
  userAta: String(r.user_ata),
  status: String(r.status) as MandateStatus,
  createdAt: Number(r.created_at),
  activatedAt: r.activated_at === null ? null : Number(r.activated_at),
  endedAt: r.ended_at === null ? null : Number(r.ended_at),
})
const toPull = (r: Row): PullRow => ({
  id: Number(r.id),
  mandateId: String(r.mandate_id),
  delegationPda: String(r.delegation_pda),
  periodStart: Number(r.period_start),
  amount: String(r.amount),
  signature: String(r.signature),
  lastValidBlockHeight: String(r.last_valid_block_height),
  state: String(r.state) as PullState,
  attempts: Number(r.attempts),
  errorCode: r.error_code === null ? null : Number(r.error_code),
  error: r.error === null ? null : String(r.error),
  nextAttemptAt: Number(r.next_attempt_at),
})

export interface Launch {
  baseMint: string
  pool: string
  config: string
  creator: string
  name: string
  symbol: string
  image: string
  quoteMint: string
  status: 'pending' | 'live'
  createdAt: number
}
const toLaunch = (r: Row): Launch => ({
  baseMint: String(r.base_mint),
  pool: String(r.pool),
  config: String(r.config),
  creator: String(r.creator),
  name: String(r.name),
  symbol: String(r.symbol),
  image: String(r.image),
  quoteMint: String(r.quote_mint),
  status: String(r.status) as Launch['status'],
  createdAt: Number(r.created_at),
})

const toBacking = (r: Row): Backing => ({
  mandateId: String(r.mandate_id),
  pool: String(r.pool),
  route: String(r.route) as Backing['route'],
  dammPool: r.damm_pool == null ? null : String(r.damm_pool),
  baseMint: String(r.base_mint),
  baseSymbol: String(r.base_symbol),
  baseDecimals: Number(r.base_decimals),
  backerBaseAta: String(r.backer_base_ata),
  slippageBps: Number(r.slippage_bps),
})

export class MandateStore {
  constructor(private readonly db: Database.Database) {
    migrateMandates(db)
  }

  // --- mandates ---

  insertMandate(m: Omit<Mandate, 'id' | 'status' | 'createdAt' | 'activatedAt' | 'endedAt'>, nowMs: number): Mandate {
    const id = randomBytes(12).toString('base64url')
    this.db
      .prepare(
        `INSERT INTO mandates (id, address, label, payee, receiver_ata, mint, symbol, decimals, amount_per_period, pull_amount,
          period_length_s, expiry_ts, nonce, delegatee, delegation_pda, authority_pda, user_ata, status, created_at)
         VALUES (@id, @address, @label, @payee, @receiverAta, @mint, @symbol, @decimals, @amountPerPeriod, @pullAmount,
          @periodLengthS, @expiryTs, @nonce, @delegatee, @delegationPda, @authorityPda, @userAta, 'pending', @now)`,
      )
      .run({ ...m, id, now: nowMs })
    return this.getMandate(id)!
  }

  getMandate(id: string): Mandate | null {
    const r = this.db.prepare('SELECT * FROM mandates WHERE id = ?').get(id) as Row | undefined
    return r ? toMandate(r) : null
  }

  getMandateByPda(pda: string): Mandate | null {
    const r = this.db
      .prepare('SELECT * FROM mandates WHERE delegation_pda = ? ORDER BY created_at DESC LIMIT 1')
      .get(pda) as Row | undefined
    return r ? toMandate(r) : null
  }

  listMandates(address: string): Mandate[] {
    return (
      this.db.prepare('SELECT * FROM mandates WHERE address = ? ORDER BY created_at DESC').all(address) as Row[]
    ).map(toMandate)
  }

  activeMandates(): Mandate[] {
    return (this.db.prepare("SELECT * FROM mandates WHERE status = 'active'").all() as Row[]).map(toMandate)
  }

  /** Pending ones count toward the tier limit, so opening many unsigned grants cannot race the cap. */
  openCount(address: string, pendingMaxAgeMs: number, nowMs: number): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM mandates WHERE address = ? AND (status = 'active' OR (status = 'pending' AND created_at > ?))",
      )
      .get(address, nowMs - pendingMaxAgeMs) as { n: number }
    return r.n
  }

  setStatus(id: string, status: MandateStatus, nowMs: number): void {
    if (status === 'active') {
      this.db.prepare("UPDATE mandates SET status = 'active', activated_at = ? WHERE id = ?").run(nowMs, id)
    } else {
      this.db.prepare('UPDATE mandates SET status = ?, ended_at = ? WHERE id = ?').run(status, nowMs, id)
    }
  }

  /** A rebuilt grant is fresh again: the stale-pending sweep counts from now. */
  touchPending(id: string, nowMs: number): void {
    this.db.prepare("UPDATE mandates SET created_at = ? WHERE id = ? AND status = 'pending'").run(nowMs, id)
  }

  deleteStalePending(maxAgeMs: number, nowMs: number): number {
    return this.db.prepare("DELETE FROM mandates WHERE status = 'pending' AND created_at < ?").run(nowMs - maxAgeMs)
      .changes
  }

  // --- pull ledger ---

  getPull(delegationPda: string, periodStart: number): PullRow | null {
    const r = this.db
      .prepare('SELECT * FROM pulls WHERE delegation_pda = ? AND period_start = ?')
      .get(delegationPda, periodStart) as Row | undefined
    return r ? toPull(r) : null
  }

  /**
   * Records the signature BEFORE the send. Returns false when a row for this
   * (delegation, period) already exists — someone already owns this period.
   */
  claimPull(
    p: Omit<PullRow, 'id' | 'state' | 'attempts' | 'errorCode' | 'error' | 'nextAttemptAt'>,
    nowMs: number,
  ): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO pulls (mandate_id, delegation_pda, period_start, amount, signature, last_valid_block_height, state, created_at, updated_at)
         VALUES (@mandateId, @delegationPda, @periodStart, @amount, @signature, @lastValidBlockHeight, 'signed', @now, @now)`,
      )
      .run({ ...p, now: nowMs })
    return r.changes === 1
  }

  /** Replaces an EXPIRED attempt's signature with a new one. Only legal once the old blockhash is dead. */
  reattemptPull(id: number, signature: string, lastValidBlockHeight: string, nowMs: number, amount?: string): void {
    this.db
      .prepare(
        "UPDATE pulls SET signature = ?, last_valid_block_height = ?, state = 'signed', attempts = attempts + 1, amount = COALESCE(?, amount), updated_at = ? WHERE id = ?",
      )
      .run(signature, lastValidBlockHeight, amount ?? null, nowMs, id)
  }

  finishPull(
    id: number,
    state: Exclude<PullState, 'signed'>,
    errorCode: number | null,
    error: string | null,
    nowMs: number,
  ): void {
    this.db
      .prepare('UPDATE pulls SET state = ?, error_code = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(state, errorCode, error, nowMs, id)
  }

  backoffPull(id: number, nextAttemptAt: number, error: string, nowMs: number): void {
    this.db
      .prepare('UPDATE pulls SET next_attempt_at = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(nextAttemptAt, error, nowMs, id)
  }

  pullsFor(delegationPda: string): PullRow[] {
    return (
      this.db.prepare('SELECT * FROM pulls WHERE delegation_pda = ? ORDER BY period_start').all(delegationPda) as Row[]
    ).map(toPull)
  }

  // --- events (receipts) ---

  /** Returns the new event id, or null when this signature already has this receipt. */
  addEvent(address: string, e: LedgerEvent, w: EventWindow = {}): number | null {
    // The permission this receipt belongs to: the latest mandate at its address
    // created before it. If the address has mandates but none that old, the
    // receipt is from an earlier account there: never recorded, never pushed.
    const mandates = this.db
      .prepare('SELECT id, created_at FROM mandates WHERE delegation_pda = ? ORDER BY created_at DESC')
      .all(e.delegationPda) as { id: string; created_at: number }[]
    const mandate = mandates.find((m) => m.created_at <= e.at + RECEIPT_SKEW_MS)
    if (mandates.length > 0 && !mandate) return null
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (address, kind, at, delegation_pda, delegatee, label, amount, decimals, symbol, signature, actor,
                                       remaining, cap, reset_ts, period_s, mandate_id, out_amount, out_decimals, out_symbol, note)
         VALUES (@address, @kind, @at, @delegationPda, @delegatee, @label, @amountBaseUnits, @decimals, @symbol, @signature, @actor,
                 @remaining, @cap, @resetTs, @periodS, @mandateId, @outBaseUnits, @outDecimals, @outSymbol, @note)`,
      )
      .run({
        address,
        mandateId: mandate?.id ?? null,
        ...e,
        outBaseUnits: e.outBaseUnits ?? null,
        outDecimals: e.outDecimals ?? null,
        outSymbol: e.outSymbol ?? null,
        note: e.note ?? null,
        remaining: w.remainingBaseUnits ?? null,
        cap: w.capBaseUnits ?? null,
        resetTs: w.nextResetTs ?? null,
        periodS: w.periodLengthS ?? null,
      })
    return r.changes === 1 ? Number(r.lastInsertRowid) : null
  }

  events(
    address: string,
    sinceMs = 0,
    limit = 200,
  ): (LedgerEvent & EventWindow & { id: number; mandateId: string | null })[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE address = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(address, sinceMs, limit) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      mandateId: r.mandate_id == null ? null : String(r.mandate_id),
      kind: String(r.kind) as EventKind,
      at: Number(r.at),
      delegationPda: String(r.delegation_pda),
      delegatee: String(r.delegatee),
      label: r.label === null ? null : String(r.label),
      amountBaseUnits: r.amount === null ? null : String(r.amount),
      decimals: Number(r.decimals),
      symbol: String(r.symbol),
      signature: r.signature === null ? null : String(r.signature),
      actor: String(r.actor) as 'nuntius' | 'other',
      remainingBaseUnits: r.remaining == null ? undefined : String(r.remaining),
      capBaseUnits: r.cap == null ? undefined : String(r.cap),
      nextResetTs: r.reset_ts == null ? undefined : Number(r.reset_ts),
      periodLengthS: r.period_s == null ? undefined : Number(r.period_s),
      outBaseUnits: r.out_amount == null ? null : String(r.out_amount),
      outDecimals: r.out_decimals == null ? null : Number(r.out_decimals),
      outSymbol: r.out_symbol == null ? null : String(r.out_symbol),
      note: r.note == null ? null : String(r.note),
    }))
  }

  // --- launches ---

  addLaunch(l: Omit<Launch, 'status' | 'createdAt'>, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO launches (base_mint, pool, config, creator, name, symbol, image, quote_mint, status, created_at)
         VALUES (@baseMint, @pool, @config, @creator, @name, @symbol, @image, @quoteMint, 'pending', @now)`,
      )
      .run({ ...l, now: nowMs })
  }

  launchByMint(baseMint: string): Launch | null {
    const r = this.db.prepare('SELECT * FROM launches WHERE base_mint = ?').get(baseMint) as Row | undefined
    return r ? toLaunch(r) : null
  }

  launchByPool(pool: string): Launch | null {
    const r = this.db.prepare('SELECT * FROM launches WHERE pool = ?').get(pool) as Row | undefined
    return r ? toLaunch(r) : null
  }

  setLaunchLive(baseMint: string): void {
    this.db.prepare("UPDATE launches SET status = 'live' WHERE base_mint = ?").run(baseMint)
  }

  // --- back permissions ---

  setBacking(b: Backing): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO backings (mandate_id, pool, route, damm_pool, base_mint, base_symbol, base_decimals, backer_base_ata, slippage_bps)
         VALUES (@mandateId, @pool, @route, @dammPool, @baseMint, @baseSymbol, @baseDecimals, @backerBaseAta, @slippageBps)`,
      )
      .run(b)
  }

  backingOf(mandateId: string): Backing | null {
    const r = this.db.prepare('SELECT * FROM backings WHERE mandate_id = ?').get(mandateId) as Row | undefined
    return r ? toBacking(r) : null
  }

  /** The route follows the token: DBC until the curve fills, then the DAMM v2 pool it migrated to. */
  setRoute(mandateId: string, route: Backing['route'], dammPool: string | null): void {
    this.db.prepare('UPDATE backings SET route = ?, damm_pool = ? WHERE mandate_id = ?').run(route, dammPool, mandateId)
  }

  /** Every live backing of a launch with its mandate's terms: the launch's committed demand. */
  /** The launch pools that live back permissions buy into. */
  backedPools(): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT b.pool FROM backings b JOIN mandates m ON m.id = b.mandate_id WHERE m.status = 'active'`,
        )
        .all() as { pool: string }[]
    ).map((r) => r.pool)
  }

  /**
   * Claims a pool's migration for this signature. 'sent' rows are ours; 'keeper' rows were
   * found already migrated. False when another claim exists.
   */
  claimMigration(
    pool: string,
    dammPool: string,
    signature: string | null,
    state: 'sent' | 'keeper',
    nowMs: number,
  ): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO migrations (pool, damm_pool, signature, state, at) VALUES (?, ?, ?, ?, ?)')
        .run(pool, dammPool, signature, state, nowMs).changes === 1
    )
  }

  finishMigration(pool: string, state: 'landed' | 'failed', costLamports: bigint | null, nowMs: number): void {
    this.db
      .prepare('UPDATE migrations SET state = ?, cost_lamports = ?, at = ? WHERE pool = ?')
      .run(state, costLamports === null ? null : costLamports.toString(), nowMs, pool)
  }

  /** A failed send is forgotten, so the crank may try again. */
  dropMigration(pool: string): void {
    this.db.prepare('DELETE FROM migrations WHERE pool = ?').run(pool)
  }

  migrationOf(pool: string): {
    pool: string
    dammPool: string
    signature: string | null
    state: string
    costLamports: string | null
    at: number
  } | null {
    const r = this.db.prepare('SELECT * FROM migrations WHERE pool = ?').get(pool) as Row | undefined
    return r
      ? {
          pool: String(r.pool),
          dammPool: String(r.damm_pool),
          signature: r.signature == null ? null : String(r.signature),
          state: String(r.state),
          costLamports: r.cost_lamports == null ? null : String(r.cost_lamports),
          at: Number(r.at),
        }
      : null
  }

  backingsOfPool(pool: string): {
    backing: Backing
    amountPerPeriod: string
    periodLengthS: number
    decimals: number
    symbol: string
    address: string
  }[] {
    return (
      this.db
        .prepare(
          `SELECT b.*, m.amount_per_period, m.period_length_s, m.decimals, m.symbol, m.address FROM backings b
             JOIN mandates m ON m.id = b.mandate_id WHERE b.pool = ? AND m.status = 'active'`,
        )
        .all(pool) as Row[]
    ).map((r) => ({
      backing: toBacking(r),
      amountPerPeriod: String(r.amount_per_period),
      periodLengthS: Number(r.period_length_s),
      decimals: Number(r.decimals),
      symbol: String(r.symbol),
      address: String(r.address),
    }))
  }

  // --- clock-in and digest ---

  clockIn(address: string, day: string, nowMs: number): boolean {
    return (
      this.db.prepare('INSERT OR IGNORE INTO clock_ins (address, day, at) VALUES (?, ?, ?)').run(address, day, nowMs)
        .changes === 1
    )
  }

  clockInDays(address: string): string[] {
    return (
      this.db.prepare('SELECT day FROM clock_ins WHERE address = ? ORDER BY day').all(address) as { day: string }[]
    ).map((r) => r.day)
  }

  setDigestPrefs(address: string, hour: number, tzOffsetMin: number, enabled: boolean, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO digest_prefs (address, hour, tz_offset_min, enabled, saved_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET hour = excluded.hour, tz_offset_min = excluded.tz_offset_min,
           enabled = excluded.enabled, saved_at = excluded.saved_at`,
      )
      .run(address, hour, tzOffsetMin, enabled ? 1 : 0, nowMs)
  }

  digestPrefs(
    address: string,
  ): { hour: number; tzOffsetMin: number; enabled: boolean; lastSentDay: string | null } | null {
    const r = this.db.prepare('SELECT * FROM digest_prefs WHERE address = ?').get(address) as Row | undefined
    return r
      ? {
          hour: Number(r.hour),
          tzOffsetMin: Number(r.tz_offset_min),
          enabled: Number(r.enabled) === 1,
          lastSentDay: r.last_sent_day === null ? null : String(r.last_sent_day),
        }
      : null
  }

  allDigestPrefs(): {
    address: string
    hour: number
    tzOffsetMin: number
    lastSentDay: string | null
    savedAtMs: number | null
    lastSentAtMs: number | null
  }[] {
    return (this.db.prepare('SELECT * FROM digest_prefs WHERE enabled = 1').all() as Row[]).map((r) => ({
      address: String(r.address),
      hour: Number(r.hour),
      tzOffsetMin: Number(r.tz_offset_min),
      lastSentDay: r.last_sent_day === null ? null : String(r.last_sent_day),
      savedAtMs: r.saved_at === null || r.saved_at === undefined ? null : Number(r.saved_at),
      lastSentAtMs: r.last_sent_at === null || r.last_sent_at === undefined ? null : Number(r.last_sent_at),
    }))
  }

  markDigestSent(address: string, day: string, nowMs: number): void {
    this.db
      .prepare('UPDATE digest_prefs SET last_sent_day = ?, last_sent_at = ? WHERE address = ?')
      .run(day, nowMs, address)
  }

  // --- guard cursor ---

  guardCursor(delegationPda: string): string | null {
    const r = this.db.prepare('SELECT last_signature FROM guard_cursor WHERE delegation_pda = ?').get(delegationPda) as
      { last_signature: string | null } | undefined
    return r ? r.last_signature : null
  }

  hasGuardCursor(delegationPda: string): boolean {
    return this.db.prepare('SELECT 1 FROM guard_cursor WHERE delegation_pda = ?').get(delegationPda) !== undefined
  }

  setGuardCursor(
    delegationPda: string,
    address: string,
    lastSignature: string | null,
    nowMs: number,
    who: { delegatee: string | null; mint: string | null } = { delegatee: null, mint: null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO guard_cursor (delegation_pda, address, delegatee, mint, last_signature, seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (delegation_pda) DO UPDATE SET last_signature = COALESCE(excluded.last_signature, last_signature),
           delegatee = COALESCE(excluded.delegatee, delegatee), mint = COALESCE(excluded.mint, mint), seen_at = excluded.seen_at`,
      )
      .run(delegationPda, address, who.delegatee, who.mint, lastSignature, nowMs)
  }

  /** What the guard last knew about a delegation — all that is left once its account is closed. */
  guardMemory(delegationPda: string): { delegatee: string | null; mint: string | null } {
    const r = this.db
      .prepare('SELECT delegatee, mint FROM guard_cursor WHERE delegation_pda = ?')
      .get(delegationPda) as { delegatee: string | null; mint: string | null } | undefined
    return r ?? { delegatee: null, mint: null }
  }

  guardedPdas(address: string): string[] {
    return (
      this.db.prepare('SELECT delegation_pda FROM guard_cursor WHERE address = ?').all(address) as {
        delegation_pda: string
      }[]
    ).map((r) => r.delegation_pda)
  }

  dropGuardCursor(delegationPda: string): void {
    this.db.prepare('DELETE FROM guard_cursor WHERE delegation_pda = ?').run(delegationPda)
  }
}
