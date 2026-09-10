import Database from 'better-sqlite3'
import type { SiwsPayload } from './siws.js'

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
  `)
  return db
}

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
    this.selectSession = db.prepare('SELECT address, sgt_mint FROM sessions WHERE token = @token')
    this.releaseSgtMint = db.prepare('UPDATE sessions SET sgt_mint = NULL WHERE sgt_mint = @mint AND token != @token')
    this.setSgtMint = db.prepare('UPDATE sessions SET sgt_mint = @mint WHERE token = @token')
    // Re-registering an existing token updates in place — unique on token, never duplicated.
    this.upsertPushTokenStmt = db.prepare(`
      INSERT INTO push_tokens (token, address, sgt_mint, platform, created_at, updated_at)
      VALUES (@token, @address, @sgtMint, @platform, @now, @now)
      ON CONFLICT (token) DO UPDATE SET address = @address, sgt_mint = @sgtMint, platform = @platform, updated_at = @now
    `)
    this.selectPushTokens = db.prepare('SELECT token FROM push_tokens WHERE address = @address')
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

  getSession(token: string): { address: string; sgtMint: string | null } | null {
    const row = this.selectSession.get({ token }) as { address: string; sgt_mint: string | null } | undefined
    return row ? { address: row.address, sgtMint: row.sgt_mint } : null
  }

  upsertPushToken(token: string, address: string, sgtMint: string | null, platform: string, nowMs: number): void {
    this.upsertPushTokenStmt.run({ token, address, sgtMint, platform, now: nowMs })
  }

  getPushTokens(address: string): string[] {
    const rows = this.selectPushTokens.all({ address }) as { token: string }[]
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
