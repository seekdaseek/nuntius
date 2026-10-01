// getProgramAccounts on Helius (getProgramAccountsV2, paged) and everywhere else (the plain
// call), and the permission list's last good scan. The RPC is a fake fetch: nothing leaves the box.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Connection, Keypair } from '@solana/web3.js'
import { createSolanaRpc, type Address } from '@solana/kit'
import { getRecurringDelegationDecoder, getRecurringDelegationEncoder } from '@solana/subscriptions'
import { CpAmm, cpAmmCoder, CpAmmIdl, POOL_TOKEN_A_MINT_OFFSET } from '@meteora-ag/cp-amm-sdk'
import {
  isHelius,
  pageConnection,
  programAccountsV2,
  withPagedProgramAccounts,
  type Fetch,
} from './program-accounts.js'
import { DelegationScans, listDelegations, PROGRAM_ID } from './mandate-chain.js'

const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=test'
const K = () => Keypair.generate().publicKey.toBase58() as Address

/** A recurring delegation account's bytes, built with the program client's own encoder. */
function delegation(delegator: Address, delegatee: Address, mint: Address): string {
  const dec = getRecurringDelegationDecoder()
  const zero = dec.decode(new Uint8Array(dec.fixedSize))
  const bytes = getRecurringDelegationEncoder().encode({
    ...zero,
    header: { ...zero.header, discriminator: 3, version: 1, delegator, delegatee, payer: delegator },
    mint,
    periodLengthS: 604_800n,
    amountPerPeriod: 5_000_000n,
  })
  return Buffer.from(bytes).toString('base64')
}

/** A fake Helius: getProgramAccountsV2 only, `perPage` accounts a page, and every request kept. */
function fakeHelius(accounts: { pubkey: string; data: string; owner: string }[], perPage: number) {
  const calls: { method: string; params: unknown[] }[] = []
  const doFetch: Fetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: string; method: string; params: unknown[] }
    calls.push(req)
    if (req.method !== 'getProgramAccountsV2') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32600,
            message:
              'Request deprioritized due to number of accounts requested. Please use getProgramAccountsV2 with pagination',
          },
        }),
      }
    }
    const cfg = req.params[1] as { paginationKey?: string }
    const start = cfg.paginationKey ? Number(cfg.paginationKey) : 0
    const page = accounts.slice(start, start + perPage)
    const next = start + perPage < accounts.length ? String(start + perPage) : null
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          accounts: page.map((a) => ({
            pubkey: a.pubkey,
            account: {
              data: [a.data, 'base64'],
              executable: false,
              lamports: 2_000_000,
              owner: a.owner,
              rentEpoch: 0,
              space: 0,
            },
          })),
          paginationKey: next,
        },
      }),
    }
  }
  return { calls, doFetch }
}

test('Helius is recognised by host; localnet and other RPCs are not', () => {
  assert.equal(isHelius(HELIUS), true)
  assert.equal(isHelius('https://beta.helius-rpc.com/?api-key=x'), true)
  assert.equal(isHelius('http://127.0.0.1:8899'), false)
  assert.equal(isHelius('https://api.mainnet-beta.solana.com'), false)
  assert.equal(isHelius('https://helius-rpc.com.evil.example'), false)
  assert.equal(isHelius('not a url'), false)
})

test('on Helius: listDelegations pages getProgramAccountsV2 with the delegator memcmp to the last page', async () => {
  const owner = K()
  const mint = K()
  const accounts = Array.from({ length: 5 }, () => ({
    pubkey: K(),
    data: delegation(owner, K(), mint),
    owner: PROGRAM_ID,
  }))
  const { calls, doFetch } = fakeHelius(accounts, 2)
  const rpc = withPagedProgramAccounts(createSolanaRpc(HELIUS), HELIUS, doFetch)
  const list = await listDelegations(rpc, owner)
  assert.equal(list.length, 5, 'all three pages')
  assert.deepEqual(
    list.map((d) => d.address),
    accounts.map((a) => a.pubkey),
  )
  assert.equal(list[0]!.kind, 'recurring')
  assert.equal(list[0]!.delegator, owner)
  assert.equal(list[0]!.amountPerPeriod, '5000000')
  assert.equal(calls.length, 3)
  assert.ok(calls.every((c) => c.method === 'getProgramAccountsV2'))
  const [program, cfg] = calls[0]!.params as [string, Record<string, unknown>]
  assert.equal(program, PROGRAM_ID)
  assert.equal(cfg.encoding, 'base64')
  assert.deepEqual(
    cfg.filters,
    [{ memcmp: { bytes: owner, encoding: 'base58', offset: 3 } }],
    'same filter, offset as a number',
  )
  assert.equal(cfg.paginationKey, undefined, 'first page has no key')
  assert.equal((calls[1]!.params[1] as Record<string, unknown>).paginationKey, '2')
  assert.equal((calls[2]!.params[1] as Record<string, unknown>).paginationKey, '4')
})

test('on Helius: an RPC error is thrown, never read as an empty list', async () => {
  const doFetch: Fetch = async () => ({ ok: false, status: 429, json: async () => ({}) })
  await assert.rejects(programAccountsV2(HELIUS, PROGRAM_ID, [], doFetch), /HTTP 429/)
  const err: Fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ error: { message: 'deprioritized' } }),
  })
  await assert.rejects(programAccountsV2(HELIUS, PROGRAM_ID, [], err), /deprioritized/)
})

test('elsewhere (localnet): the plain getProgramAccounts, untouched', () => {
  const rpc = createSolanaRpc('http://127.0.0.1:8899')
  assert.equal(withPagedProgramAccounts(rpc, 'http://127.0.0.1:8899'), rpc, 'the same client')
  const conn = new Connection('http://127.0.0.1:8899')
  const plain = conn.getProgramAccounts
  assert.equal(pageConnection(conn).getProgramAccounts, plain)
})

test('the Meteora DAMM v2 lookup pages on Helius too (connection.getProgramAccounts → V2)', async () => {
  const baseMint = Keypair.generate().publicKey
  const poolKey = K()
  const size = cpAmmCoder.accounts.size('Pool')
  const data = Buffer.alloc(size)
  Buffer.from(CpAmmIdl.accounts.find((a) => a.name === 'Pool')!.discriminator).copy(data)
  baseMint.toBuffer().copy(data, POOL_TOKEN_A_MINT_OFFSET)
  const { calls, doFetch } = fakeHelius(
    [{ pubkey: poolKey, data: data.toString('base64'), owner: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' }],
    1000,
  )
  const conn = pageConnection(new Connection(HELIUS, 'confirmed'), doFetch)
  const pools = await new CpAmm(conn).fetchPoolStatesByTokenAMint(baseMint)
  assert.equal(pools.length, 1)
  assert.equal(pools[0]!.publicKey.toBase58(), poolKey)
  assert.equal(pools[0]!.account.tokenAMint.toBase58(), baseMint.toBase58())
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, 'getProgramAccountsV2')
  const filters = (calls[0]!.params[1] as { filters: { memcmp?: { offset: number; bytes: string } }[] }).filters
  assert.ok(
    filters.some((f) => f.memcmp?.offset === POOL_TOKEN_A_MINT_OFFSET && f.memcmp.bytes === baseMint.toBase58()),
  )
})

test('a failed scan shows the last good list with its time, never "no permissions"', async () => {
  const owner = K()
  const accounts = [{ pubkey: K(), data: delegation(owner, K(), K()), owner: PROGRAM_ID }]
  const good = fakeHelius(accounts, 10)
  let fail = false
  const doFetch: Fetch = async (url, init) =>
    fail ? { ok: false, status: 503, json: async () => ({}) } : good.doFetch(url, init)
  let t = 1_000_000
  const scans = new DelegationScans(withPagedProgramAccounts(createSolanaRpc(HELIUS), HELIUS, doFetch), () => t)

  // Never scanned and failing: an error, not an empty list.
  fail = true
  await assert.rejects(scans.orLast(owner))

  fail = false
  const first = await scans.orLast(owner)
  assert.deepEqual([first.list.length, first.stale, first.asOfMs], [1, false, 1_000_000])

  fail = true
  t = 1_300_000
  const later = await scans.orLast(owner)
  assert.equal(later.stale, true)
  assert.equal(later.asOfMs, 1_000_000, 'the time of the last good scan')
  assert.equal(later.list[0]!.address, accounts[0]!.pubkey)
  await assert.rejects(scans.fresh(owner), 'anything that acts on the list still gets the error')
})
