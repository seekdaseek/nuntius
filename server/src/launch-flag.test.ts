// v1.0.1: subscription launches (back permissions, launches) stay off unless the
// server is started with MANDATE_LAUNCHES=1. Off means the routes do not exist.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.js'
import { openDb, Store } from './db.js'
import { MandateStore } from './mandate-store.js'
import { loadMandateConfig } from './mandate-config.js'
import { RateLimiter } from './rate-limit.js'
import type { Config } from './config.js'

async function serve(launches: boolean) {
  const db = openDb(':memory:')
  const config = { port: 0, domain: 'x.app', heliusRpc: null, fcmServiceAccount: null, fcmProjectId: null }
  const lim = () => new RateLimiter(100, 60_000)
  const app = createApp(
    config as unknown as Config,
    new Store(db),
    null,
    undefined,
    {
      mandates: new MandateStore(db),
      cfg: { cluster: 'localnet', mints: [], demoEndpoints: false, launches },
      rpc: null,
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

const post = (base: string, path: string) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

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

test('launches on: the same routes exist (they refuse a bad request instead)', async () => {
  const s = await serve(true)
  try {
    for (const p of ['/api/mandates/back', '/api/launch/create', '/api/launch/confirm'])
      assert.equal((await post(s.base, p)).status, 400, p)
    assert.equal((await fetch(`${s.base}/api/launch/not-a-pool`)).status, 400)
  } finally {
    s.close()
  }
})
