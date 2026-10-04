// getProgramAccounts on Helius (getProgramAccountsV2, paged) and everywhere else (the plain
// call), and the permission list's last good scan. The RPC is a fake fetch: nothing leaves the box.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createSolanaRpc, getAddressDecoder, type Address } from '@solana/kit'
import { getRecurringDelegationDecoder, getRecurringDelegationEncoder } from '@solana/subscriptions'
import { isHelius, programAccountsV2, withPagedProgramAccounts, type Fetch } from './program-accounts.js'
import { DelegationScans, listDelegations, PROGRAM_ID } from './mandate-chain.js'
import { fakeHelius } from './test/fake-helius.js'

const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=test'
const K = () => getAddressDecoder().decode(randomBytes(32))

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
