// The primary RPC (a Helius URL) answers 429, as it did from 23 Oct when the free plan's credits
// ran out: every caller moves to the fallback, stays there for the window, then probes the
// primary again. The network is a fake fetch: the kit transport reads the global one, web3.js
// and the V2 pager the endpoints' own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSolanaRpcFromTransport, generateKeyPairSigner, type Address } from '@solana/kit'
import { PublicKey } from '@solana/web3.js'
import { FALLBACK_STAY_MS, failsOver, parseFallbacks, PUBLIC_MAINNET_RPC, RpcEndpoints } from './rpc-endpoints.js'
import { withPagedProgramAccounts } from './program-accounts.js'
import { meteoraConnection } from './meteora.js'
import { rpcChain } from './executor.js'
import { rpcGuardChain } from './guard.js'
import { checkWalletForSgt } from './seeker.js'
import { createLogger } from './log.js'

const PRIMARY = 'https://mainnet.helius-rpc.com/?api-key=test-key-not-real'
const FALLBACK = 'https://fallback.test/'
const PROGRAM = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44'

/** Answers per method, enough for each caller below. */
function answer(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'getSlot':
      return 7
    case 'getBalance':
      return { context: { slot: 1 }, value: 5_000 }
    case 'getAccountInfo': {
      const clock = Buffer.alloc(40)
      clock.writeBigInt64LE(1_800_000_000n, 32)
      return params[0] === 'SysvarC1ock11111111111111111111111111111111'
        ? {
            context: { slot: 1 },
            value: {
              data: [clock.toString('base64'), 'base64'],
              owner: '11111111111111111111111111111111',
              lamports: 1,
              executable: false,
              rentEpoch: 0,
              space: 40,
            },
          }
        : { context: { slot: 1 }, value: null }
    }
    case 'getProgramAccounts':
      return []
    case 'getProgramAccountsV2':
      return { accounts: [], paginationKey: null }
    case 'getSignaturesForAddress':
      return [
        { signature: '5'.repeat(88), slot: 1, err: null, memo: null, blockTime: 1, confirmationStatus: 'confirmed' },
      ]
    case 'getTokenAccountsByOwner':
    case 'getTokenAccountsByOwnerV2':
      return { context: { slot: 1 }, value: method.endsWith('V2') ? { accounts: [] } : [] }
    case 'getMultipleAccounts':
      return { context: { slot: 1 }, value: [] }
    default:
      return null
  }
}

/** A network where the primary answers `primaryStatus` and the fallback answers everything. */
function network() {
  const calls: { host: string; method: string; status: number }[] = []
  let primaryStatus = 429
  const fetch = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const host = new URL(String(url)).host
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string; params?: unknown[] }
    const status = host === 'mainnet.helius-rpc.com' ? primaryStatus : 200
    calls.push({ host, method: body.method, status })
    if (status !== 200) return new Response('max usage reached', { status })
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answer(body.method, body.params ?? []) }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    )
  }
  return {
    calls,
    fetch,
    setPrimary: (s: number) => (primaryStatus = s),
    take: () =>
      calls
        .splice(0)
        .map((c) => `${c.host === 'mainnet.helius-rpc.com' ? 'primary' : 'fallback'} ${c.method} ${c.status}`),
  }
}

function setup() {
  const net = network()
  let now = 1_000_000
  const lines: string[] = []
  const ep = new RpcEndpoints(PRIMARY, [FALLBACK], {
    now: () => now,
    fetch: net.fetch as typeof fetch,
    log: createLogger((l) => lines.push(l)),
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = net.fetch as typeof fetch
  const rpc = withPagedProgramAccounts(createSolanaRpcFromTransport(ep.transport()), PRIMARY, ep.fetch as never, () =>
    ep.primaryUp(),
  )
  return {
    net,
    ep,
    rpc,
    lines,
    advance: (ms: number) => (now += ms),
    restore: () => (globalThis.fetch = realFetch),
  }
}

test('RPC_FALLBACKS: unset is the public mainnet RPC, empty is none, anything but https is refused', () => {
  assert.deepEqual(parseFallbacks(undefined), [PUBLIC_MAINNET_RPC])
  assert.deepEqual(parseFallbacks(''), [])
  assert.deepEqual(parseFallbacks(' https://a.test , https://b.test/x '), ['https://a.test', 'https://b.test/x'])
  assert.throws(() => parseFallbacks('http://a.test'), /https/)
  for (const s of [429, 402, 403, 500, 502, 503, 504]) assert.equal(failsOver(s), true, String(s))
  for (const s of [200, 400, 401, 404]) assert.equal(failsOver(s), false, String(s))
})

test('the kit Rpc: a 429 moves the call to the fallback, the next calls start there, and the primary is probed after 10 minutes', async () => {
  const t = setup()
  try {
    assert.equal(await t.rpc.getSlot().send(), 7n)
    assert.deepEqual(t.net.take(), ['primary getSlot 429', 'fallback getSlot 200'])
    assert.equal(t.lines.filter((l) => l.includes('rpc_failover')).length, 1)
    assert.match(
      t.lines.find((l) => l.includes('rpc_failover'))!,
      /"from":"mainnet.helius-rpc.com".*"why":"429"/,
    )
    assert.doesNotMatch(t.lines.join('\n'), /test-key-not-real/, 'the key never reaches a log line')
    // Within the window: straight to the fallback.
    t.advance(FALLBACK_STAY_MS - 1)
    assert.equal((await t.rpc.getBalance('11111111111111111111111111111111' as Address).send()).value, 5_000n)
    assert.deepEqual(t.net.take(), ['fallback getBalance 200'])
    // After it, the primary again; it answers now.
    t.advance(1)
    t.net.setPrimary(200)
    assert.equal(await t.rpc.getSlot().send(), 7n)
    assert.deepEqual(t.net.take(), ['primary getSlot 200'])
    assert.equal(t.lines.filter((l) => l.includes('rpc_primary_back')).length, 1)
    const u = t.ep.takeUsage()
    assert.deepEqual(u.calls, { getSlot: 3, getBalance: 1 })
    assert.deepEqual(u.hosts, { 'mainnet.helius-rpc.com': 2, 'fallback.test': 2 })
  } finally {
    t.restore()
  }
})

test('402, 403 and 5xx move the call too; a 400 is an answer and stays', async () => {
  for (const status of [402, 403, 500, 503]) {
    const t = setup()
    try {
      t.net.setPrimary(status)
      assert.equal(await t.rpc.getSlot().send(), 7n)
      assert.deepEqual(t.net.take(), [`primary getSlot ${status}`, 'fallback getSlot 200'])
    } finally {
      t.restore()
    }
  }
  const t = setup()
  try {
    t.net.setPrimary(400)
    await assert.rejects(t.rpc.getSlot().send())
    assert.deepEqual(t.net.take(), ['primary getSlot 400'])
  } finally {
    t.restore()
  }
})

test('getProgramAccounts: V2 on Helius while it answers; on a 429 the plain call goes to the fallback, and V2 is not tried while down', async () => {
  const t = setup()
  try {
    const gpa = () =>
      (t.rpc.getProgramAccounts as unknown as (p: string, c: unknown) => { send(): Promise<unknown[]> })(PROGRAM, {
        encoding: 'base64',
        filters: [],
      }).send()
    assert.deepEqual(await gpa(), [])
    assert.deepEqual(t.net.take(), ['primary getProgramAccountsV2 429', 'fallback getProgramAccounts 200'])
    assert.deepEqual(await gpa(), [])
    assert.deepEqual(t.net.take(), ['fallback getProgramAccounts 200'], 'no V2 call to a primary that is down')
    t.advance(FALLBACK_STAY_MS)
    t.net.setPrimary(200)
    assert.deepEqual(await gpa(), [])
    assert.deepEqual(t.net.take(), ['primary getProgramAccountsV2 200'])
  } finally {
    t.restore()
  }
})

test('the web3.js connections (buys, crank, launch routes): the same fallback, through the endpoints fetch', async () => {
  for (const retryRateLimits of [true, false]) {
    const t = setup()
    try {
      const conn = meteoraConnection(PRIMARY, undefined, { retryRateLimits, endpoints: t.ep })
      assert.equal(await conn.getSlot(), 7)
      assert.equal(await conn.getAccountInfo(new PublicKey(PROGRAM)), null)
      assert.deepEqual(t.net.take(), ['primary getSlot 429', 'fallback getSlot 200', 'fallback getAccountInfo 200'])
      // An SDK account.all() (getProgramAccounts) on the same connection: plain, on the fallback.
      assert.deepEqual(await conn.getProgramAccounts(new PublicKey(PROGRAM)), [])
      assert.deepEqual(t.net.take(), ['fallback getProgramAccounts 200'])
    } finally {
      t.restore()
    }
  }
})

test('every caller moves: the executor (clock, delegation, balance), the guard (signatures), the Seeker check', async () => {
  const t = setup()
  try {
    const chain = rpcChain(t.rpc as never, await generateKeyPairSigner())
    assert.equal(await chain.clock!(), 1_800_000_000n)
    assert.equal((await chain.read('11111111111111111111111111111111')).exists, false)
    assert.equal(await chain.balance!(), 5_000n)
    const guard = rpcGuardChain(t.rpc as never)
    assert.deepEqual(await guard.signatures('11111111111111111111111111111111', null), ['5'.repeat(88)])
    // Helius-only getTokenAccountsByOwnerV2: refused on the primary, then the plain call on the fallback.
    assert.equal(
      await checkWalletForSgt(PRIMARY, '11111111111111111111111111111111', {
        fetch: t.ep.fetch,
        useV2: () => true,
      }),
      null,
    )
    assert.deepEqual(t.net.take(), [
      'primary getAccountInfo 429',
      'fallback getAccountInfo 200',
      'fallback getAccountInfo 200',
      'fallback getBalance 200',
      'fallback getSignaturesForAddress 200',
      'primary getTokenAccountsByOwnerV2 429',
      'fallback getTokenAccountsByOwner 200',
    ])
  } finally {
    t.restore()
  }
})

test('both down: the caller gets the error, and the next call tries the fallback first', async () => {
  const t = setup()
  try {
    t.net.setPrimary(429)
    const failing = async (url: unknown, init?: RequestInit) =>
      new URL(String(url)).host === 'fallback.test' ? new Response('down', { status: 503 }) : t.net.fetch(url, init)
    globalThis.fetch = failing as typeof fetch
    await assert.rejects(t.rpc.getSlot().send(), /503/)
    assert.deepEqual(t.ep.order(), [FALLBACK, PRIMARY])
  } finally {
    t.restore()
  }
})
