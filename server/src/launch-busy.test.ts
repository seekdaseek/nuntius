// The backing page's routes during a 429 burst (8 to 15 Oct, up to about 40 minutes each): a busy
// RPC answers 503 chain_busy with a Retry-After, never "not a launch" (404), "bad pool" (400) or
// "not landed" (409). Each of those stays for a pool that really is not one. The chain is a fake
// connection whose reads fail as web3.js words a rate limit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Keypair, PublicKey, type Connection } from '@solana/web3.js'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createApp } from './app.js'
import { openDb, Store } from './db.js'
import { MandateStore } from './mandate-store.js'
import { Receipts } from './receipts.js'
import { createLogger } from './log.js'
import { CLIENT_HEADER } from './client-version.js'
import type { Config } from './config.js'
import { curvePoolAccount, presetConfigAccount } from './test/dbc-fakes.js'

const K = () => Keypair.generate().publicKey.toBase58()
const SESSION = 'B'.repeat(43)
const DBC_ID = DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()

/** A curve on chain: its config and pool. The quote mint is not one the server offers (no price lookup). */
function curve() {
  const config = K()
  const baseMint = K()
  const pool = K()
  const accounts = new Map([
    [config, { owner: DBC_ID, data: presetConfigAccount(K(), K()) }],
    [pool, { owner: DBC_ID, data: curvePoolAccount(config, baseMint) }],
  ])
  return { config, baseMint, pool, accounts }
}

/** The chain as the SDKs read it, where read n (from 1) fails with a 429 when `busy(n)` says so. */
function chain(accounts: Map<string, { owner: string; data: Buffer }>, busy: (n: number) => boolean) {
  let reads = 0
  const info = (k: PublicKey) => {
    reads += 1
    if (busy(reads)) throw new Error('429 Too Many Requests: Too Many Requests')
    const a = accounts.get(k.toBase58())
    return a ? { owner: new PublicKey(a.owner), data: a.data, lamports: 1, executable: false, rentEpoch: 0 } : null
  }
  return {
    rpcEndpoint: 'fake',
    commitment: 'confirmed',
    getAccountInfo: async (k: PublicKey) => info(k),
    getAccountInfoAndContext: async (k: PublicKey) => ({ context: { slot: 1 }, value: info(k) }),
    getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map(info),
    getSlot: async () => {
      reads += 1
      if (busy(reads)) throw new Error('429 Too Many Requests: Too Many Requests')
      return 1
    },
  } as unknown as Connection
}

async function serve(conn: Connection, launches: { baseMint: string; pool: string; config: string }[] = []) {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.createSession(SESSION, 'Backer11111111111111111111111111111111111111', Date.now())
  store.claimSgtMint(SESSION, 'Sgt1111111111111111111111111111111111111111')
  const mandates = new MandateStore(db)
  for (const l of launches)
    mandates.addLaunch(
      {
        ...l,
        creator: K(),
        name: 'busy',
        symbol: 'BUSY',
        image: 'https://x.test/i.png',
        quoteMint: K(),
        description: null,
      },
      Date.now(),
    )
  const app = createApp(
    { port: 0, domain: 'x.test', heliusRpc: null, fcmServiceAccount: null, fcmProjectId: null } as unknown as Config,
    store,
    null,
    {
      mandates,
      cfg: {
        cluster: 'localnet',
        rpcUrl: 'http://127.0.0.1:1',
        mints: [{ symbol: 'TQ', mint: K(), decimals: 6 }],
        maxPerPeriodUi: '100',
        delegateePath: null,
        executorIntervalMs: 30_000,
        guardIntervalMs: 60_000,
        demoEndpoints: false,
        launches: true,
        launchConfigs: {},
      },
      rpc: {} as never,
      delegatee: K() as never,
      receipts: new Receipts(
        mandates,
        null,
        createLogger(() => {}),
        'localnet',
      ),
      executor: null,
      conn,
      origin: 'https://x.test',
    },
  )
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

const post = (base: string, path: string, body: object) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1.1.0' },
    body: JSON.stringify({ session: SESSION, ...body }),
  })

/** What the page sees: status, error code, Retry-After. */
const seen = async (r: Response) => {
  const j = (await r.json()) as { ok: boolean; error?: string; launch?: { pool: string } }
  return { status: r.status, error: j.error ?? null, retryAfter: r.headers.get('retry-after'), launch: j.launch }
}

test('GET /api/launch/:pool: a busy RPC is 503 chain_busy with a Retry-After, never 404 no_launch', async () => {
  const c = curve()
  const s = await serve(chain(c.accounts, () => true))
  try {
    assert.deepEqual(await seen(await fetch(`${s.base}/api/launch/${c.pool}`)), {
      status: 503,
      error: 'chain_busy',
      retryAfter: '5',
      launch: undefined,
    })
  } finally {
    s.close()
  }
})

test('GET /api/launch/:pool: two busy reads, then the launch (the reads are tried again)', async () => {
  const c = curve()
  const s = await serve(chain(c.accounts, (n) => n <= 2))
  try {
    const r = await seen(await fetch(`${s.base}/api/launch/${c.pool}`))
    assert.equal(r.status, 200)
    assert.equal(r.launch?.pool, c.pool)
  } finally {
    s.close()
  }
})

test('GET /api/launch/:pool: a pool that is not one is still 404 no_launch', async () => {
  const c = curve()
  const s = await serve(chain(c.accounts, () => false))
  try {
    assert.equal((await seen(await fetch(`${s.base}/api/launch/${K()}`))).error, 'no_launch')
    assert.equal((await seen(await fetch(`${s.base}/api/launch/${c.config}`))).error, 'no_launch')
  } finally {
    s.close()
  }
})

test('POST /api/mandates/back: a busy RPC is 503 chain_busy, never 400 bad_pool; a non-pool stays bad_pool', async () => {
  const c = curve()
  const terms = { symbol: 'TQ', amount: '1', period: 'day', untilDays: 30 }
  const busy = await serve(chain(c.accounts, () => true))
  try {
    const r = await seen(await post(busy.base, '/api/mandates/back', { ...terms, pool: c.pool }))
    assert.deepEqual([r.status, r.error, r.retryAfter], [503, 'chain_busy', '5'])
  } finally {
    busy.close()
  }
  const calm = await serve(chain(c.accounts, () => false))
  try {
    const r = await seen(await post(calm.base, '/api/mandates/back', { ...terms, pool: K() }))
    assert.deepEqual([r.status, r.error], [400, 'bad_pool'])
  } finally {
    calm.close()
  }
})

test('POST /api/launch/confirm: a busy RPC is 503; a launch not on chain stays 409 not_on_chain_yet', async () => {
  const c = curve()
  const landed = { baseMint: c.baseMint, pool: c.pool, config: c.config }
  const notYet = { baseMint: K(), pool: K(), config: c.config }
  const busy = await serve(
    chain(c.accounts, () => true),
    [landed],
  )
  try {
    const r = await seen(await post(busy.base, '/api/launch/confirm', { baseMint: c.baseMint }))
    assert.deepEqual([r.status, r.error, r.retryAfter], [503, 'chain_busy', '5'])
  } finally {
    busy.close()
  }
  const calm = await serve(
    chain(c.accounts, () => false),
    [landed, notYet],
  )
  try {
    const missing = await seen(await post(calm.base, '/api/launch/confirm', { baseMint: notYet.baseMint }))
    assert.deepEqual([missing.status, missing.error], [409, 'not_on_chain_yet'])
    const live = await seen(await post(calm.base, '/api/launch/confirm', { baseMint: c.baseMint }))
    assert.deepEqual([live.status, live.launch?.pool], [200, c.pool])
  } finally {
    calm.close()
  }
})
