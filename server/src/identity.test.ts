import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.js'
import { openDb, Store } from './db.js'
import { MandateStore } from './mandate-store.js'
import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { parseCertFingerprint } from './identity.js'
import { clientIp, RateLimiter, retryMessage, type Limits } from './rate-limit.js'

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')

function limits(max = 2): Limits {
  return {
    rpc: new RateLimiter(max, 60_000),
    siwsPayload: new RateLimiter(max, 60_000),
    siwsVerify: new RateLimiter(max, 60_000),
    demoPerIp: new RateLimiter(10, 60_000),
    demoPerMandate: new RateLimiter(1, 60_000),
  }
}

async function serve(cfg: Partial<Config>, withMandates = false) {
  const db = openDb(':memory:')
  const store = new Store(db)
  const config = {
    port: 0,
    domain: 'nuntius.ochinimus.app',
    heliusRpc: null,
    fcmServiceAccount: null,
    fcmProjectId: null,
    ...cfg,
  } as unknown as Config
  const mandates = withMandates
    ? ({
        mandates: new MandateStore(db),
        cfg: { cluster: 'localnet', mints: [], demoEndpoints: true },
        rpc: null,
        delegatee: 'D',
        receipts: null,
        executor: null,
      } as never)
    : undefined
  const app = createApp(config, store, null, mandates, {
    limits: limits(),
    staticDir: path.join(import.meta.dirname, '..', 'static'),
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

test('ANDROID_CERT_SHA256 is validated as 32 colon-separated hex bytes', () => {
  assert.equal(parseCertFingerprint(undefined), null)
  assert.equal(parseCertFingerprint(''), null)
  assert.equal(parseCertFingerprint(FP.toLowerCase()), FP, 'normalised to upper case')
  assert.throws(() => parseCertFingerprint('AB:CD'))
  assert.throws(() => parseCertFingerprint(FP + ':00'))
  assert.throws(() => parseCertFingerprint(FP.replace(/:/g, '')))
  assert.throws(() => loadConfig({ NUNTIUS_DOMAIN: 'x.app', ANDROID_CERT_SHA256: 'nope' }))
  assert.equal(loadConfig({ NUNTIUS_DOMAIN: 'x.app', ANDROID_CERT_SHA256: FP }).androidCertSha256, FP)
})

test('assetlinks.json: 404 until configured, then the android_app statement as application/json', async () => {
  const off = await serve({})
  const r0 = await fetch(`${off.base}/.well-known/assetlinks.json`)
  assert.equal(r0.status, 404)
  off.close()

  const on = await serve({ androidCertSha256: FP })
  const r = await fetch(`${on.base}/.well-known/assetlinks.json`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') ?? '', /^application\/json/)
  const body = (await r.json()) as {
    relation: string[]
    target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] }
  }[]
  assert.equal(body.length, 1)
  assert.ok(body[0]!.relation.includes('delegate_permission/common.handle_all_urls'))
  assert.deepEqual(body[0]!.target, {
    namespace: 'android_app',
    package_name: 'app.ochinimus.nuntius',
    sha256_cert_fingerprints: [FP],
  })
  const icon = await fetch(`${on.base}/identity-icon-192.png`)
  assert.equal(icon.status, 200)
  assert.equal(icon.headers.get('content-type'), 'image/png')
  const bytes = new Uint8Array(await icon.arrayBuffer())
  assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47], 'PNG magic')
  on.close()
})

test('the bare domain redirects to the repository; any other unknown path stays a JSON 404', async () => {
  const on = await serve({ androidCertSha256: FP }, true)
  try {
    for (const method of ['GET', 'HEAD']) {
      const r = await fetch(`${on.base}/`, { method, redirect: 'manual' })
      assert.deepEqual(
        [r.status, r.headers.get('location'), r.headers.get('cache-control')],
        [302, 'https://github.com/seekdaseek/nuntius', 'no-cache'],
        method,
      )
    }
    const other = await fetch(`${on.base}/nope`, { redirect: 'manual' })
    assert.deepEqual(
      [other.status, other.headers.get('cache-control'), await other.json()],
      [404, 'no-store', { ok: false, error: 'not_found' }],
    )
    const post = await fetch(`${on.base}/`, { method: 'POST', redirect: 'manual' })
    assert.equal(post.status, 404, 'only GET and HEAD move')
    // The App Links statement is untouched.
    const links = await fetch(`${on.base}/.well-known/assetlinks.json`, { redirect: 'manual' })
    assert.equal(links.status, 200)
    assert.equal(
      ((await links.json()) as { target: { sha256_cert_fingerprints: string[] } }[])[0]!.target
        .sha256_cert_fingerprints[0],
      FP,
    )
  } finally {
    on.close()
  }
})

test('rate limits: /api/rpc, /api/siws-payload and /api/siws-verify answer 429 with JSON past the limit', async () => {
  const s = await serve({})
  for (const [method, p] of [
    ['POST', '/api/rpc'],
    ['GET', '/api/siws-payload'],
    ['POST', '/api/siws-verify'],
  ] as const) {
    const hit = () =>
      fetch(`${s.base}${p}`, {
        method,
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
        body: method === 'POST' ? '{}' : undefined,
      })
    assert.notEqual((await hit()).status, 429)
    assert.notEqual((await hit()).status, 429)
    const r = await hit()
    assert.equal(r.status, 429, p)
    const j = (await r.json()) as { error: string; message: string }
    assert.equal(j.error, 'rate_limited')
    assert.match(j.message, /^Too many tries\. Try again in \d+ (second|minute)s?\.$/, 'a sentence the app can show')
    assert.ok(Number(r.headers.get('retry-after')) > 0)
    // A different client behind the tunnel has its own bucket.
    const other = await fetch(`${s.base}${p}`, {
      method,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
      body: method === 'POST' ? '{}' : undefined,
    })
    assert.notEqual(other.status, 429, `${p}: separate bucket per CF-Connecting-IP`)
  }
  s.close()
})

test('demo-overcap: one call per mandate per window, before any work is done', async () => {
  const s = await serve({}, true)
  const hit = (mandateId: string) =>
    fetch(`${s.base}/api/mandates/demo-overcap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mandateId, session: 'x' }),
    })
  assert.equal((await hit('m1')).status, 400, 'first call reaches the handler (and fails auth)')
  const r = await hit('m1')
  assert.equal(r.status, 429)
  const j = (await r.json()) as { error: string; message: string }
  assert.equal(j.error, 'rate_limited')
  assert.match(j.message, /^Too many tries\. Try again in (1 minute|\d+ seconds)\.$/, 'shown under "Try to take more"')
  assert.equal((await hit('m2')).status, 400, 'another mandate is not blocked')
  s.close()
})

test('demo-overcap: capped per client IP across mandates, with a separate bucket per CF-Connecting-IP', async () => {
  const s = await serve({}, true)
  const hit = (mandateId: string, ip: string) =>
    fetch(`${s.base}/api/mandates/demo-overcap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ mandateId, session: 'x' }),
    })
  // The test limiter allows 10 per window per IP; each call names a new mandate.
  for (let i = 0; i < 10; i++) assert.equal((await hit(`m${i}`, '203.0.113.7')).status, 400, `call ${i + 1}`)
  const r = await hit('m10', '203.0.113.7')
  assert.equal(r.status, 429, 'the 11th call from one IP is refused even for a fresh mandate')
  assert.equal(((await r.json()) as { error: string }).error, 'rate_limited')
  assert.ok(Number(r.headers.get('retry-after')) > 0)
  assert.equal((await hit('m11', '198.51.100.9')).status, 400, 'another client is not blocked')
  s.close()
})

test('clientIp trusts CF-Connecting-IP only from the loopback tunnel', () => {
  const req = (remote: string, cf?: string) =>
    ({ socket: { remoteAddress: remote }, headers: cf ? { 'cf-connecting-ip': cf } : {} }) as never
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7')
  assert.equal(clientIp(req('::ffff:127.0.0.1', '2001:db8::1')), '2001:db8::1')
  assert.equal(clientIp(req('198.51.100.2', '203.0.113.7')), '198.51.100.2', 'direct caller cannot spoof it')
  assert.equal(clientIp(req('127.0.0.1', 'not an ip<script>')), '127.0.0.1')
  const t = { now: 0 }
  const l = new RateLimiter(2, 1000, () => t.now)
  assert.equal(l.take('a'), 0)
  assert.equal(l.take('a'), 0)
  assert.equal(l.take('a'), 1)
  t.now = 1000
  assert.equal(l.take('a'), 0, 'window resets')
  assert.equal(retryMessage(1), 'Too many tries. Try again in 1 second.')
  assert.equal(retryMessage(45), 'Too many tries. Try again in 45 seconds.')
  assert.equal(retryMessage(60), 'Too many tries. Try again in 1 minute.')
  assert.equal(retryMessage(61), 'Too many tries. Try again in 2 minutes.')
  assert.equal(retryMessage(3600), 'Too many tries. Try again in 60 minutes.')
})

test('token assets under /t/: files from static/tokens, plain names only', async () => {
  const s = await serve({})
  try {
    const r = await fetch(`${s.base}/t/proof.json`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') ?? '', /^application\/json/)
    const j = (await r.json()) as { name: string; symbol: string }
    assert.equal(j.symbol, 'PROOF')
    assert.match(j.name, /not for trading/)
    for (const bad of ['missing.png', '..%2Fidentity-icon-192.png', 'Proof.json', 'proof.txt', '.json'])
      assert.equal((await fetch(`${s.base}/t/${bad}`)).status, 404, bad)
  } finally {
    s.close()
  }
})
