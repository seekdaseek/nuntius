// v1.0.1: sign-out ends the session on the server, and a push token lives only as
// long as the session that registered it (revoked or expired: no more receipts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { createApp } from './app.js'
import { openDb, SESSION_TTL_MS, Store } from './db.js'
import { RateLimiter } from './rate-limit.js'
import type { Config } from './config.js'

const S1 = 'a'.repeat(42) + '1'
const S2 = 'b'.repeat(42) + '2'
const TOKEN = (n: number) => `fcmInstance${n}:${'x'.repeat(140)}`

async function serve(store: Store) {
  const lim = () => new RateLimiter(100, 60_000)
  const config = { port: 0, domain: 'x.app', heliusRpc: null, fcmServiceAccount: null, fcmProjectId: null }
  const app = createApp(config as unknown as Config, store, null, undefined, {
    limits: { rpc: lim(), siwsPayload: lim(), siwsVerify: lim(), demoPerIp: lim(), demoPerMandate: lim() },
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { post, close: () => server.close() }
}

test('sign-out: the session stops working and its push tokens are gone; other sessions keep theirs', async () => {
  const store = new Store(openDb(':memory:'))
  const now = Date.now()
  store.createSession(S1, 'Wallet', now)
  store.createSession(S2, 'Wallet', now)
  const s = await serve(store)
  try {
    assert.equal(
      (await s.post('/api/push/register', { session: S1, token: TOKEN(1), platform: 'android' })).status,
      200,
    )
    assert.equal(
      (await s.post('/api/push/register', { session: S2, token: TOKEN(2), platform: 'android' })).status,
      200,
    )
    assert.deepEqual(store.getPushTokens('Wallet').sort(), [TOKEN(1), TOKEN(2)])

    assert.equal((await s.post('/api/session/revoke', { session: S1 })).status, 200)
    assert.equal(store.getSession(S1), null, 'the session no longer authenticates')
    assert.deepEqual(store.getPushTokens('Wallet'), [TOKEN(2)], 'the signed-out phone gets no more receipts')
    // A stolen copy of the revoked session cannot register a token to receive them either.
    assert.equal(
      (await s.post('/api/push/register', { session: S1, token: TOKEN(3), platform: 'android' })).status,
      401,
    )
    assert.equal((await s.post('/api/session/revoke', { session: S1 })).status, 200, 'idempotent')
    assert.equal((await s.post('/api/session/revoke', { session: 'nope' })).status, 400)
  } finally {
    s.close()
  }
})

test('an expired session stops receiving at once, and the hourly purge deletes it with its tokens', () => {
  const db = openDb(':memory:')
  const store = new Store(db)
  const now = Date.now()
  store.createSession(S1, 'Wallet', now - SESSION_TTL_MS + 60_000) // expires in a minute
  store.upsertPushToken(TOKEN(1), 'Wallet', null, 'android', now, S1)
  assert.deepEqual(store.getPushTokens('Wallet', now), [TOKEN(1)])
  assert.deepEqual(store.pushAddresses(now), ['Wallet'])
  const later = now + 120_000
  assert.deepEqual(store.getPushTokens('Wallet', later), [], 'expired: nothing is sent')
  assert.deepEqual(store.pushAddresses(later), [])
  assert.deepEqual(store.purgeExpiredSessions(later), { sessions: 1, pushTokens: 1 })
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM push_tokens').get() as { n: number }).n, 0)
})

test('upgrade: tokens registered before v1.0.1 are bound to their wallet’s newest session', () => {
  const file = `/tmp/nuntius-session-test-${process.pid}.db`
  const old = new Database(file)
  old.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, address TEXT NOT NULL, sgt_mint TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE push_tokens (token TEXT PRIMARY KEY, address TEXT NOT NULL, sgt_mint TEXT, platform TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`)
  const now = Date.now()
  old.prepare('INSERT INTO sessions VALUES (?, ?, NULL, ?)').run(S1, 'Wallet', now - 1000)
  old.prepare('INSERT INTO sessions VALUES (?, ?, NULL, ?)').run(S2, 'Wallet', now)
  old.prepare("INSERT INTO push_tokens VALUES (?, 'Wallet', NULL, 'android', ?, ?)").run(TOKEN(1), now, now)
  old.close()
  const store = new Store(openDb(file))
  assert.deepEqual(store.getPushTokens('Wallet'), [TOKEN(1)], 'pushes keep arriving after the server update')
  store.revokeSession(S2)
  assert.deepEqual(store.getPushTokens('Wallet'), [], 'and the token goes with the session it was bound to')
})
