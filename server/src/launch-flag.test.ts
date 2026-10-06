// v1.0.1: subscription launches (back permissions, launches) stay off unless the
// server is started with MANDATE_LAUNCHES=1. Off means the routes do not exist.
// v1.1.0: on, they are still off for any app that does not send x-nuntius-client 1.1.0 or
// later. The v1.0.2 APK sends no header, so it sees exactly what it sees with launches off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createApp } from './app.js'
import { openDb, Store } from './db.js'
import { MandateStore } from './mandate-store.js'
import { loadMandateConfig } from './mandate-config.js'
import { RateLimiter } from './rate-limit.js'
import type { Config } from './config.js'
import { CLIENT_HEADER, clientAtLeast, launchesFor, parseVersion } from './client-version.js'
import { userAtaOf } from './mandate-chain.js'
import type { Address } from '@solana/kit'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const SESSION = 'S'.repeat(43)
const WALLET = 'Backer11111111111111111111111111111111111111'

async function serve(
  launches: boolean,
  owners: Record<string, string> = {},
  tokenAccounts: Record<string, object> = {},
) {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.createSession(SESSION, WALLET, Date.now())
  const config = { port: 0, domain: 'x.app', heliusRpc: null, fcmServiceAccount: null, fcmProjectId: null }
  const lim = () => new RateLimiter(100, 60_000)
  // Just enough chain for the list: no delegations, and no token account for the one mint.
  // `owners` gives some addresses an account owned by that program (a pool, for the payee check).
  const rpc = {
    getAccountInfo: (address: string) => ({
      send: async () => ({
        value: owners[address]
          ? { owner: owners[address] }
          : tokenAccounts[address]
            ? {
                owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                data: { parsed: { info: tokenAccounts[address] } },
              }
            : null,
      }),
    }),
  }
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
        maxPerPeriodUi: '100',
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

test('the web backing page: /l/<pool> with a strict CSP and this server’s config; assets by name only', async () => {
  const s = await serve(true)
  try {
    const r = await fetch(`${s.base}/l/5qeAeoorEHpwecPkehAVedeYaWhMVpJaFMD52A8oAtHX`)
    assert.equal(r.status, 200)
    const csp = r.headers.get('content-security-policy') ?? ''
    // The whole policy, so any widening is a decision: the Mobile Wallet Adapter's local
    // association in connect-src, and its dialogs' own styles by hash (web/build.mjs).
    const mwa = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '..', 'static', 'l', 'mwa-csp.json'), 'utf8'),
    ) as { styles: string[]; attributes: string[] }
    assert.ok(mwa.styles.length >= 5 && mwa.attributes.length >= 1)
    assert.ok([...mwa.styles, ...mwa.attributes].every((h) => /^'sha256-[A-Za-z0-9+/]{43}='$/.test(h)))
    assert.equal(
      csp,
      "default-src 'none'; script-src 'self'; " +
        `style-src 'self' 'unsafe-hashes' ${[...mwa.styles, ...mwa.attributes].join(' ')}; ` +
        "font-src 'self'; img-src 'self' data: https:; " +
        "connect-src 'self' ws://localhost:* http://localhost; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    assert.match(csp, /script-src 'self'/)
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/)
    const html = await r.text()
    const config = JSON.parse(
      /<script type="application\/json" id="config">\s*([\s\S]*?)\s*<\/script>/.exec(html)![1]!,
    ) as {
      executor: string
      mints: { symbol: string }[]
    }
    assert.equal(config.executor, 'D', 'the executor this server pulls with')
    assert.deepEqual(
      config.mints.map((m) => m.symbol),
      ['USDC'],
    )
    // Script and stylesheet by content hash, so no browser runs a script from another deploy.
    const js = /src="(\/l\/assets\/backing\.js\?v=[0-9a-f]{12})"/.exec(html)?.[1]
    const css = /href="(\/l\/assets\/backing\.css\?v=[0-9a-f]{12})"/.exec(html)?.[1]
    assert.ok(js && css, 'versioned asset URLs')
    const bundle = readFileSync(path.join(import.meta.dirname, '..', 'static', 'l', 'backing.js'))
    assert.equal(js.slice(-12), createHash('sha256').update(bundle).digest('hex').slice(0, 12))
    assert.equal((await fetch(`${s.base}${js}`)).status, 200)
    assert.equal((await fetch(`${s.base}${css}`)).status, 200)
    assert.equal((await fetch(`${s.base}/l/assets/backing.js`)).status, 200)
    assert.equal((await fetch(`${s.base}/l/not-a-pool`)).status, 404)
    assert.equal((await fetch(`${s.base}/l/assets/index.html`)).status, 404)
    assert.equal((await fetch(`${s.base}/l/assets/..%2F..%2Fpackage.json`)).status, 404)
  } finally {
    s.close()
  }
})

test('a Meteora pool pasted as a payee, its token account created: refused first, and named for what it is', async () => {
  const POOL = 'BpYoKpXwvM4gvD1VxenZAZ9vzV9QWdqZWKXm8DW3dPPU'
  const PERSON = 'Ana1111111111111111111111111111111111111111'
  // The pool's own USDC account exists (anyone can create it): the account check alone would pass.
  const poolAta = await userAtaOf(POOL as Address, USDC as Address)
  const s = await serve(
    true,
    { [POOL]: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN' },
    { [poolAta]: { owner: POOL, mint: USDC, tokenAmount: { amount: '0', decimals: 6 } } },
  )
  const create = async (payee: string, client?: string) => {
    const r = await post(s.base, '/api/mandates/create', client, {
      session: SESSION,
      label: 'Nimus',
      payee,
      symbol: 'USDC',
      amount: '1',
      period: 'day',
      untilDays: 30,
    })
    return { status: r.status, ...((await r.json()) as { error: string; message: string }) }
  }
  try {
    const onNew = await create(POOL, '1.1.0')
    assert.equal(onNew.status, 400)
    assert.equal(onNew.error, 'payee_is_pool')
    assert.match(onNew.message, /Meteora launch pool, not a wallet\. To buy its token every period, use Back a launch/)
    const onOld = await create(POOL)
    assert.equal(onOld.status, 400)
    assert.equal(onOld.error, 'payee_is_pool')
    const onOld102 = await create(POOL, '1.0.2')
    assert.equal(onOld102.error, 'payee_is_pool')
    assert.equal(onOld102.message, onOld.message)
    assert.equal(onOld.message, 'that address is a Meteora pool, not a wallet, so it cannot be paid.')
    // A wallet without the token account: the answer it always had.
    const person = await create(PERSON, '1.1.0')
    assert.deepEqual([person.error, person.message], ['payee_has_no_account', 'the payee has no USDC account yet'])
  } finally {
    s.close()
  }
})
