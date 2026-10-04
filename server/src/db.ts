import Database from 'better-sqlite3'
import type { SiwsPayload } from './siws.js'

export interface DelegationRow {
  delegationPda: string
  address: string
  mint: string
  userAta: string
  authorityPda: string
  delegatee: string
  amountPerPeriod: string
  periodLengthS: number
}

export interface StoredDelegation extends DelegationRow {
  receiverAta: string | null
}

export function openDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      sgt_mint TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_sgt_mint ON sessions (sgt_mint);
    CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      sgt_mint TEXT,
      platform TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_tokens_address ON push_tokens (address);
    CREATE TABLE IF NOT EXISTS delegations (
      delegation_pda TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      mint TEXT NOT NULL,
      user_ata TEXT NOT NULL,
      receiver_ata TEXT,
      authority_pda TEXT NOT NULL,
      delegatee TEXT NOT NULL,
      amount_per_period TEXT NOT NULL,
      period_length_s INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegations_address ON delegations (address);
  `)
  // v1.0.1: a push token belongs to the session that registered it, and goes with it.
  const cols = db.prepare('PRAGMA table_info(push_tokens)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'session')) {
    db.exec('ALTER TABLE push_tokens ADD COLUMN session TEXT')
    // Tokens registered before v1.0.1 carry no session: bind each to its wallet's newest
    // session, so pushes keep arriving until the app re-registers on its next start.
    db.exec(`UPDATE push_tokens SET session = (
      SELECT token FROM sessions WHERE sessions.address = push_tokens.address ORDER BY created_at DESC LIMIT 1
    ) WHERE session IS NULL`)
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_tokens_session ON push_tokens (session)')
  return db
}

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

export class Store {
  private readonly insertNonce
  private readonly consumeNonceStmt
  private readonly pruneNonces
  private readonly insertSession
  private readonly selectSession
  private readonly releaseSgtMint
  private readonly setSgtMint
  private readonly upsertPushTokenStmt
  private readonly selectPushTokens
  private readonly upsertDelegationStmt
  private readonly selectDelegationStmt
  private readonly setReceiverAtaStmt

  constructor(private readonly db: Database.Database) {
    this.insertNonce = db.prepare(
      'INSERT INTO nonces (nonce, payload, issued_at, expires_at) VALUES (@nonce, @payload, @issuedAt, @expiresAt)',
    )
    // Single UPDATE ... RETURNING: marking the nonce used and reading its payload is one
    // atomic operation, so a nonce can never verify twice, even under concurrent requests.
    this.consumeNonceStmt = db.prepare(
      'UPDATE nonces SET used_at = @now WHERE nonce = @nonce AND used_at IS NULL AND expires_at > @now RETURNING payload',
    )
    this.pruneNonces = db.prepare('DELETE FROM nonces WHERE expires_at < @cutoff')
    this.insertSession = db.prepare(
      'INSERT INTO sessions (token, address, created_at) VALUES (@token, @address, @createdAt)',
    )
    this.selectSession = db.prepare(
      'SELECT address, sgt_mint FROM sessions WHERE token = @token AND created_at > @notBefore',
    )
    this.releaseSgtMint = db.prepare('UPDATE sessions SET sgt_mint = NULL WHERE sgt_mint = @mint AND token != @token')
    this.setSgtMint = db.prepare('UPDATE sessions SET sgt_mint = @mint WHERE token = @token')
    // Re-registering an existing token updates in place — unique on token, never duplicated.
    this.upsertPushTokenStmt = db.prepare(`
      INSERT INTO push_tokens (token, address, sgt_mint, platform, session, created_at, updated_at)
      VALUES (@token, @address, @sgtMint, @platform, @session, @now, @now)
      ON CONFLICT (token) DO UPDATE SET address = @address, sgt_mint = @sgtMint, platform = @platform,
        session = @session, updated_at = @now
    `)
    // Only tokens whose session is still live: a revoked or expired session receives nothing.
    this.selectPushTokens = db.prepare(`
      SELECT p.token FROM push_tokens p JOIN sessions s ON s.token = p.session
      WHERE p.address = @address AND s.created_at > @notBefore
    `)
    this.upsertDelegationStmt = db.prepare(`
      INSERT INTO delegations (delegation_pda, address, mint, user_ata, authority_pda, delegatee, amount_per_period, period_length_s, created_at)
      VALUES (@delegationPda, @address, @mint, @userAta, @authorityPda, @delegatee, @amountPerPeriod, @periodLengthS, @now)
      ON CONFLICT (delegation_pda) DO UPDATE SET mint=@mint, user_ata=@userAta, authority_pda=@authorityPda,
        delegatee=@delegatee, amount_per_period=@amountPerPeriod, period_length_s=@periodLengthS
    `)
    this.selectDelegationStmt = db.prepare(
      'SELECT * FROM delegations WHERE address = @address ORDER BY created_at DESC LIMIT 1',
    )
    this.setReceiverAtaStmt = db.prepare('UPDATE delegations SET receiver_ata = @ata WHERE delegation_pda = @pda')
  }

  upsertDelegation(row: DelegationRow, nowMs: number): void {
    this.upsertDelegationStmt.run({ ...row, now: nowMs })
  }

  /** Most recent delegation for a wallet. The caller's session decides the wallet. */
  getDelegation(address: string): StoredDelegation | null {
    const r = this.selectDelegationStmt.get({ address }) as Record<string, string | number> | undefined
    if (!r) return null
    return {
      delegationPda: String(r.delegation_pda),
      address: String(r.address),
      mint: String(r.mint),
      userAta: String(r.user_ata),
      receiverAta: r.receiver_ata ? String(r.receiver_ata) : null,
      authorityPda: String(r.authority_pda),
      delegatee: String(r.delegatee),
      amountPerPeriod: String(r.amount_per_period),
      periodLengthS: Number(r.period_length_s),
    }
  }

  setReceiverAta(delegationPda: string, ata: string): void {
    this.setReceiverAtaStmt.run({ pda: delegationPda, ata })
  }

  issueNonce(payload: SiwsPayload): void {
    this.pruneNonces.run({ cutoff: Date.now() - 60 * 60 * 1000 })
    this.insertNonce.run({
      nonce: payload.nonce,
      payload: JSON.stringify(payload),
      issuedAt: Date.parse(payload.issuedAt),
      expiresAt: Date.parse(payload.expirationTime),
    })
  }

  /** Returns the issued payload and burns the nonce, or null if unknown, expired or already used. */
  consumeNonce(nonce: string, nowMs: number): SiwsPayload | null {
    const row = this.consumeNonceStmt.get({ nonce, now: nowMs }) as { payload: string } | undefined
    if (!row) return null
    return JSON.parse(row.payload) as SiwsPayload
  }

  createSession(token: string, address: string, nowMs: number): void {
    this.insertSession.run({ token, address, createdAt: nowMs })
  }

  /**
   * A session lives SESSION_TTL_MS (30 days) from sign-in, then the wallet must
   * sign in again. It never authorizes a transfer on its own — every grant and
   * revoke is still signed in Seed Vault — but a token that never expires is a
   * standing liability on a lost phone.
   */
  getSession(token: string, nowMs: number = Date.now()): { address: string; sgtMint: string | null } | null {
    const row = this.selectSession.get({ token, notBefore: nowMs - SESSION_TTL_MS }) as
      { address: string; sgt_mint: string | null } | undefined
    return row ? { address: row.address, sgtMint: row.sgt_mint } : null
  }

  /** Binds a device's push token to the session that registered it. */
  upsertPushToken(
    token: string,
    address: string,
    sgtMint: string | null,
    platform: string,
    nowMs: number,
    session: string,
  ): void {
    this.upsertPushTokenStmt.run({ token, address, sgtMint, platform, now: nowMs, session })
  }

  /**
   * Sign-out: the session stops working on the server, and every push token it
   * registered is deleted, so a copied session token neither reads nor receives
   * anything afterwards. Returns whether the session existed.
   */
  revokeSession(token: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM push_tokens WHERE session = ?').run(token)
      return this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token).changes > 0
    })()
  }

  /** Expired sessions go, with their push tokens (and any token left without a live session). */
  purgeExpiredSessions(nowMs: number = Date.now()): { sessions: number; pushTokens: number } {
    const notBefore = nowMs - SESSION_TTL_MS
    return this.db.transaction(() => {
      const pushTokens = this.db
        .prepare(
          'DELETE FROM push_tokens WHERE session IS NULL OR session NOT IN (SELECT token FROM sessions WHERE created_at > ?)',
        )
        .run(notBefore).changes
      const sessions = this.db.prepare('DELETE FROM sessions WHERE created_at <= ?').run(notBefore).changes
      return { sessions, pushTokens }
    })()
  }

  /** Seeker verification for a wallet, from any of its sessions. Used where no session is in hand (scheduled digest). */
  sgtForAddress(address: string): string | null {
    const r = this.db
      .prepare('SELECT sgt_mint FROM sessions WHERE address = ? AND sgt_mint IS NOT NULL LIMIT 1')
      .get(address) as { sgt_mint: string } | undefined
    return r?.sgt_mint ?? null
  }

  /** Every wallet with at least one registered device — the set the guard watches. */
  pushAddresses(nowMs: number = Date.now()): string[] {
    return (
      this.db
        .prepare(
          'SELECT DISTINCT p.address FROM push_tokens p JOIN sessions s ON s.token = p.session WHERE s.created_at > ?',
        )
        .all(nowMs - SESSION_TTL_MS) as { address: string }[]
    ).map((r) => r.address)
  }

  getPushTokens(address: string, nowMs: number = Date.now()): string[] {
    const rows = this.selectPushTokens.all({ address, notBefore: nowMs - SESSION_TTL_MS }) as { token: string }[]
    return rows.map((r) => r.token)
  }

  /**
   * An SGT moves between a user's own Seed Vault accounts when they change their primary
   * account; its mint address never changes. So uniqueness is keyed on the mint address,
   * never the wallet. Claiming a mint releases it from every other session first: one
   * physical Seeker is one verified identity, whichever of the user's accounts holds it.
   */
  claimSgtMint(token: string, mint: string): void {
    const claim = this.db.transaction(() => {
      this.releaseSgtMint.run({ mint, token })
      this.setSgtMint.run({ mint, token })
    })
    claim()
  }
}
