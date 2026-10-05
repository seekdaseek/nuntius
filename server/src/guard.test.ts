// The guard as the backstop for a grant the app never confirmed (device round 6,
// 5 Oct 2026): the grant landed at 05:39:14 UTC, the wallet answered with an
// error 84 s later, the app never called /api/mandates/confirm, and the
// stale-pending sweep then forgot a live permission. Unit tests on a fake chain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { Address } from '@solana/kit'
import { Guard, type GuardChain } from './guard.js'
import { MandateStore, termsMatch } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
import { createLogger } from './log.js'
import type { DelegationView } from './mandate-chain.js'

const OWNER = 'Owner11111111111111111111111111111111111111'
const DELEGATEE = 'DeLegatee1111111111111111111111111111111111'
const PDA = 'PdaDeLegation1111111111111111111111111111111'

function setup() {
  const store = new MandateStore(new Database(':memory:'))
  const pushes: { title: string; body: string }[] = []
  const push: PushPort = {
    async toAddress(_address, msg) {
      pushes.push(msg)
      return [200]
    },
  }
  const lines: string[] = []
  const log = createLogger((l) => lines.push(l))
  const receipts = new Receipts(store, push, log, 'localnet')
  const m = store.insertMandate(
    {
      address: OWNER,
      label: 'Ana',
      payee: 'Payee',
      receiverAta: 'ReceiverAta',
      mint: 'Mint',
      symbol: 'USDC',
      decimals: 6,
      amountPerPeriod: '50000',
      pullAmount: '50000',
      periodLengthS: 86_400,
      expiryTs: 1_791_800_000,
      nonce: 1,
      delegatee: DELEGATEE,
      delegationPda: PDA,
      authorityPda: 'Auth',
      userAta: 'UserAta',
    },
    1_000,
  )
  let live: DelegationView[] = []
  const chain: GuardChain = {
    list: async () => live,
    signatures: async () => [],
    effect: async () => {
      throw new Error('no activity in these tests')
    },
  }
  let kicks = 0
  const guard = new Guard({
    store,
    chain,
    receipts,
    log,
    addresses: () => [OWNER],
    mintInfo: () => ({ symbol: 'USDC', decimals: 6 }),
    onActivated: () => kicks++,
    now: () => 2_000,
  })
  const view = (o: Partial<DelegationView> = {}): DelegationView => ({
    address: PDA as Address,
    kind: 'recurring',
    delegator: OWNER as Address,
    delegatee: DELEGATEE as Address,
    mint: 'Mint' as Address,
    amountPerPeriod: '50000',
    amountPulledInPeriod: '0',
    currentPeriodStartTs: 0,
    periodLengthS: 86_400,
    expiryTs: 1_791_800_000,
    amount: null,
    ...o,
  })
  return {
    store,
    m,
    guard,
    pushes,
    lines,
    kicks: () => kicks,
    setLive: (v: DelegationView[]) => {
      live = v
    },
    view,
  }
}

test('guard: a pending permission found live on chain with its exact terms is activated', async () => {
  const s = setup()
  await s.guard.scan(OWNER) // the silent baseline, before the grant
  s.setLive([s.view()])
  await s.guard.scan(OWNER)
  assert.equal(s.store.getMandate(s.m.id)!.status, 'active')
  assert.equal(s.store.getMandate(s.m.id)!.activatedAt, 2_000)
  assert.equal(s.kicks(), 1, 'the executor is kicked, so the first pull goes out at once')
  assert.match(s.lines.join('\n'), /"event":"mandate_activated_from_chain"/)
  assert.equal(s.pushes.length, 1, 'one "granted" receipt')
  assert.match(`${s.pushes[0]!.title} ${s.pushes[0]!.body}`, /Ana/, 'with the permission name, not "another app"')
  // A later confirm from the app finds it active; the sweep no longer touches it.
  assert.equal(s.store.deleteStalePending(0, 10 ** 13), 0)
  await s.guard.scan(OWNER)
  assert.equal(s.kicks(), 1, 'activated once')
})

test('guard: different terms on chain leave the permission pending', async () => {
  for (const [what, o] of [
    ['amount', { amountPerPeriod: '50001' }],
    ['period', { periodLengthS: 3_600 }],
    ['expiry', { expiryTs: 1_791_800_001 }],
    ['delegatee', { delegatee: 'Other11111111111111111111111111111111111111' as Address }],
    ['mint', { mint: 'OtherMint' as Address }],
  ] as const) {
    const s = setup()
    await s.guard.scan(OWNER)
    s.setLive([s.view(o)])
    await s.guard.scan(OWNER)
    assert.equal(s.store.getMandate(s.m.id)!.status, 'pending', what)
    assert.equal(s.kicks(), 0, what)
  }
})

test('termsMatch: the confirm route and the guard use one exact match', () => {
  const s = setup()
  const chain = {
    delegator: OWNER,
    delegatee: DELEGATEE,
    mint: 'Mint',
    periodLengthS: 86_400n,
    expiryTs: 1_791_800_000n,
  }
  assert.ok(termsMatch(s.m, { ...chain, amountPerPeriod: 50_000n }), 'bigints, as readRecurring returns them')
  assert.ok(termsMatch(s.m, { ...chain, amountPerPeriod: '50000', periodLengthS: 86_400, expiryTs: 1_791_800_000 }))
  assert.ok(!termsMatch(s.m, { ...chain, amountPerPeriod: null }), 'not a recurring delegation')
  assert.ok(!termsMatch(s.m, { ...chain, amountPerPeriod: 50_000n, delegator: DELEGATEE }), 'another wallet')
  assert.ok(!termsMatch(s.m, {}), 'no delegation at all')
})
