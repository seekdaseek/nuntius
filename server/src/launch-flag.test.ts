// v1.0.1: subscription launches (back permissions, launches) stay off unless the
// server is started with MANDATE_LAUNCHES=1. Off means the routes do not exist.
// v1.1.0: on, they are still off for any app that does not send x-nuntius-client 1.1.0 or
// later. The v1.0.2 APK sends no header, so it sees exactly what it sees with launches off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.js'
import { openDb, Store } from './db.js'
import { MandateStore } from './mandate-store.js'
import { loadMandateConfig } from './mandate-config.js'
import { RateLimiter } from './rate-limit.js'
import type { Config } from './config.js'
import { CLIENT_HEADER, clientAtLeast, launchesFor, parseVersion } from './client-version.js'

const SESSION = 'S'.repeat(43)
const WALLET = 'Backer11111111111111111111111111111111111111'

async function serve(launches: boolean) {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.createSession(SESSION, WALLET, Date.now())
  const config = { port: 0, domain: 'x.app', heliusRpc: null, fcmServiceAccount: null, fcmProjectId: null }
  const lim = () => new RateLimiter(100, 60_000)
  // Just enough chain for the list: no delegations, and no token account for the one mint.
  const rpc = { getAccountInfo: () => ({ send: async () => ({ value: null }) }) }
  const scans = { orLast: async () => ({ list: [], asOfMs: Date.now(), stale: false }) }
  const app = createApp(
    config as unknown as Config,
    store,
    null,
    {
      mandates: new MandateStore(db),
      cfg: {
        cluster: 'localnet',
        mints: [{ symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }],
        demoEndpoints: false,
        launches,
      },
      rpc,
      scans,
      delegatee: 'D',
      receipts: null,
      executor: null,
      conn: {},
    } as never,
    { limits: { rpc: lim(), siwsPayload: lim(), siwsVerify: lim(), demoPerIp: lim(), demoPerMandate: lim() } },
  )
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

const post = (base: string, path: string, client?: string, body: object = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(client === undefined ? {} : { [CLIENT_HEADER]: client }) },
    body: JSON.stringify(body),
  })

/** What the list tells this client about launches. */
const listed = async (base: string, client?: string) => {
  const r = await post(base, '/api/mandates/list', client, { session: SESSION })
  assert.equal(r.status, 200)
  return ((await r.json()) as { features: { launches: boolean } }).features.launches
}

/** Status, content type and body: what a client can tell apart. */
const answer = async (r: Response) => `${r.status} ${r.headers.get('content-type')} ${await r.text()}`

const LAUNCH_POSTS = ['/api/mandates/back', '/api/launch/create', '/api/launch/confirm']
const OLD_CLIENTS: (string | undefined)[] = [
  undefined,
  '1.0.2',
  '1.0.99',
  '',
  'garbage',
  '1.1',
  '1.1.0-beta',
  'v1.1.0',
  '1.1.0, 1.1.0',
]

test('MANDATE_LAUNCHES: off unless set to 1', () => {
  const env = {
    MANDATE_CLUSTER: 'localnet',
    MANDATE_RPC: 'http://127.0.0.1:8899',
    MANDATE_MINTS: 'T:So11111111111111111111111111111111111111112:6',
  }
  assert.equal(loadMandateConfig(env, null)!.launches, false)
  assert.equal(loadMandateConfig({ ...env, MANDATE_LAUNCHES: '0' }, null)!.launches, false)
  assert.equal(loadMandateConfig({ ...env, MANDATE_LAUNCHES: '1' }, null)!.launches, true)
})

test('launches off: back, launch and the public read-out are not served', async () => {
  const s = await serve(false)
  try {
    for (const p of ['/api/mandates/back', '/api/launch/create', '/api/launch/confirm'])
      assert.equal((await post(s.base, p)).status, 404, p)
    assert.equal((await fetch(`${s.base}/api/launch/not-a-pool`)).status, 404)
  } finally {
    s.close()
  }
})

test('launches on, app 1.1.0: the same routes exist (they refuse a bad request instead)', async () => {
  const s = await serve(true)
  try {
    for (const p of LAUNCH_POSTS) assert.equal((await post(s.base, p, '1.1.0')).status, 400, p)
    assert.equal((await fetch(`${s.base}/api/launch/not-a-pool`)).status, 400)
  } finally {
    s.close()
  }
})

test('client version: only a well-formed 1.1.0 or later counts', () => {
  for (const v of OLD_CLIENTS) assert.equal(clientAtLeast(v), false, String(v))
  // Leading and trailing spaces never reach the server (HTTP strips them), but the parser refuses them too.
  assert.equal(clientAtLeast(' 1.1.0'), false)
  for (const v of ['1.1.0', '1.1.1', '1.2.0', '1.10.0', '2.0.0']) assert.equal(clientAtLeast(v), true, v)
  assert.deepEqual(parseVersion('1.1.0'), [1, 1, 0])
  assert.equal(parseVersion(['1.1.0']), null)
  assert.equal(launchesFor(false, '9.9.9'), false, 'the server flag off wins')
  assert.equal(launchesFor(true, undefined), false)
  assert.equal(launchesFor(true, '1.1.0'), true)
})

test('launches on: the list says launches only to an app at 1.1.0 or later', async () => {
  const on = await serve(true)
  const off = await serve(false)
  try {
    for (const v of OLD_CLIENTS) assert.equal(await listed(on.base, v), false, `on, client ${String(v)}`)
    assert.equal(await listed(on.base, '1.1.0'), true)
    assert.equal(await listed(on.base, '1.2.3'), true)
    for (const v of [undefined, '1.0.2', '1.1.0']) assert.equal(await listed(off.base, v), false, `off, ${String(v)}`)
  } finally {
    on.close()
    off.close()
  }
})

test('launches on, an older app: back, create and confirm answer exactly as with launches off', async () => {
  const on = await serve(true)
  const off = await serve(false)
  try {
    for (const p of LAUNCH_POSTS) {
      const asOff = await answer(await post(off.base, p))
      assert.match(asOff, /^404 /, `${p} with launches off`)
      for (const v of OLD_CLIENTS) {
        const body = { session: SESSION, pool: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'x', symbol: 'XX' }
        assert.equal(await answer(await post(on.base, p, v, body)), asOff, `${p}, client ${String(v)}`)
      }
    }
  } finally {
    on.close()
    off.close()
  }
})
