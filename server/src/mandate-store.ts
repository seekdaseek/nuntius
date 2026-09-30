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

/** The permission's window right after a receipt, in base units: what the meter draws. */
export interface EventWindow {
  remainingBaseUnits?: string
  capBaseUnits?: string
  nextResetTs?: number
  periodLengthS?: number
}

export type PullState = 'signed' | 'landed' | 'refused' | 'failed'

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
    const r = this.db.prepare('SELECT * FROM mandates WHERE delegation_pda = ?').get(pda) as Row | undefined
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
  reattemptPull(id: number, signature: string, lastValidBlockHeight: string, nowMs: number): void {
    this.db
      .prepare(
        "UPDATE pulls SET signature = ?, last_valid_block_height = ?, state = 'signed', attempts = attempts + 1, updated_at = ? WHERE id = ?",
      )
      .run(signature, lastValidBlockHeight, nowMs, id)
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
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (address, kind, at, delegation_pda, delegatee, label, amount, decimals, symbol, signature, actor,
                                       remaining, cap, reset_ts, period_s)
         VALUES (@address, @kind, @at, @delegationPda, @delegatee, @label, @amountBaseUnits, @decimals, @symbol, @signature, @actor,
                 @remaining, @cap, @resetTs, @periodS)`,
      )
      .run({
        address,
        ...e,
        remaining: w.remainingBaseUnits ?? null,
        cap: w.capBaseUnits ?? null,
        resetTs: w.nextResetTs ?? null,
        periodS: w.periodLengthS ?? null,
      })
    return r.changes === 1 ? Number(r.lastInsertRowid) : null
  }

  events(address: string, sinceMs = 0, limit = 200): (LedgerEvent & EventWindow & { id: number })[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE address = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(address, sinceMs, limit) as Row[]
    ).map((r) => ({
      id: Number(r.id),
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
  }[] {
    return (this.db.prepare('SELECT * FROM digest_prefs WHERE enabled = 1').all() as Row[]).map((r) => ({
      address: String(r.address),
      hour: Number(r.hour),
      tzOffsetMin: Number(r.tz_offset_min),
      lastSentDay: r.last_sent_day === null ? null : String(r.last_sent_day),
      savedAtMs: r.saved_at === null || r.saved_at === undefined ? null : Number(r.saved_at),
    }))
  }

  markDigestSent(address: string, day: string): void {
    this.db.prepare('UPDATE digest_prefs SET last_sent_day = ? WHERE address = ?').run(day, address)
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
