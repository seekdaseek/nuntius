/**
 * The mandatum life cycle against the real Subscriptions program on a local
 * validator: one-signature grant, delegatee-only pulls, the chain's 0x190
 * refusal, a second mandate on the same authority, and one-signature revokes
 * that leave the token account `delegate: none`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Address } from '@solana/kit'
import {
  buildGrantTx,
  buildRevokeTx,
  DelegationScans,
  ERR,
  listDelegations,
  pullInstruction,
  readAta,
  readRecurring,
} from './mandate-chain.js'
import { withPagedProgramAccounts } from './program-accounts.js'
import {
  assertOk,
  ataFor,
  deviceSignAndSend,
  funded,
  LOCALNET_RPC,
  mintTo,
  requireLocal,
  requiredSigners,
  signAndLand,
  skipLocalnet,
  tokenBalance,
} from './test/localnet.js'

const U64_MAX = '18446744073709551615'

test('mandate life cycle on the real program', { skip: skipLocalnet, timeout: 120_000 }, async (t) => {
  const rpc = requireLocal()
  const owner = await funded(rpc) // plays the Seeker user
  const delegatee = await funded(rpc) // plays the nuntius executor key
  const merchant = await funded(rpc) // a second, foreign delegatee
  const { mint, ata: userAta } = await mintTo(rpc, owner, owner.address, 1_000_000n)
  const receiverAta = await ataFor(rpc, delegatee, mint, delegatee.address)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const terms = {
    owner: owner.address,
    mint,
    delegatee: delegatee.address,
    nonce: 0n,
    amountPerPeriod: 10_000n,
    periodLengthS: 3600n,
    startTs: 0n,
    expiryTs: now + 86_400n,
  }

  let delegationPda: Address
  let authorityPda: Address

  await t.test('grant: one transaction, one signer, authority created in the same transaction', async () => {
    const grant = await buildGrantTx(rpc, terms)
    assert.equal(grant.createsAuthority, true)
    assert.deepEqual(requiredSigners(grant.transactionBase64), [owner.address], 'the owner is the only signer')
    const landed = assertOk(await deviceSignAndSend(rpc, owner, grant.transactionBase64))
    console.log(`    grant signature ${landed.signature}`)
    delegationPda = grant.delegationPda
    authorityPda = grant.authorityPda

    const d = await readRecurring(rpc, delegationPda)
    assert.equal(d.exists, true)
    assert.equal(d.amountPerPeriod, 10_000n)
    assert.equal(d.periodLengthS, 3600n)
    assert.equal(d.delegatee, delegatee.address)
    assert.equal(d.delegator, owner.address)
    assert.equal(d.amountPulledInPeriod, 0n)

    const ata = await readAta(rpc, userAta)
    assert.equal(ata.delegate, authorityPda, 'token account delegate is the Subscription Authority PDA')
    // init approves u64::MAX; the grant's approveChecked lowers it to the lifetime total.
    assert.equal(grant.allowance, 240_000n, '24 hourly periods of 10_000 before the one-day expiry')
    assert.equal(ata.delegatedAmount, '240000', 'the token allowance is the lifetime total, not u64::MAX')
    assert.notEqual(ata.delegatedAmount, U64_MAX)
  })

  // Pulls sent by hand to the program, refusals included, so they land as evidence.
  const pull = async (amount: bigint, signer = delegatee, pda = () => delegationPda) =>
    signAndLand(rpc, signer, [
      await pullInstruction({
        delegatee: signer,
        delegationPda: pda(),
        delegator: owner.address,
        delegatorAta: userAta,
        receiverAta,
        mint,
        amount,
      }),
    ])

  await t.test('pull within the cap: signed by the delegatee alone', async () => {
    const before = await tokenBalance(rpc, userAta)
    const l = assertOk(await pull(4_000n))
    assert.equal(await tokenBalance(rpc, userAta), before - 4_000n)
    assert.equal(await tokenBalance(rpc, receiverAta), 4_000n)
    const d = await readRecurring(rpc, delegationPda)
    assert.equal(d.amountPulledInPeriod, 4_000n)
    console.log(`    pull signature ${l.signature}`)
  })

  await t.test('over-cap pull: the chain refuses with 0x190 and nothing moves', async () => {
    const before = await tokenBalance(rpc, userAta)
    const l = await pull(6_001n) // 4,000 used + 6,001 > 10,000
    assert.equal(l.customCode, ERR.AmountExceedsPeriodLimit)
    assert.match(l.err ?? '', /"Custom":400/)
    assert.equal(await tokenBalance(rpc, userAta), before)
    console.log(`    refused signature ${l.signature} err ${l.err}`)
    // exactly the remainder is still allowed
    assertOk(await pull(6_000n))
    assert.equal((await pull(1n)).customCode, ERR.AmountExceedsPeriodLimit, 'one base unit past the cap is refused')
  })

  let merchantPda: Address
  await t.test('second mandate on the same mint: authority exists, real init_id, still one signer', async () => {
    const grant = await buildGrantTx(rpc, { ...terms, delegatee: merchant.address, amountPerPeriod: 2_500n })
    assert.equal(grant.createsAuthority, false)
    assert.deepEqual(requiredSigners(grant.transactionBase64), [owner.address])
    assertOk(await deviceSignAndSend(rpc, owner, grant.transactionBase64))
    merchantPda = grant.delegationPda
    const all = await listDelegations(rpc, owner.address)
    assert.equal(all.length, 2)
    assert.deepEqual(new Set(all.map((d) => d.delegatee)), new Set([delegatee.address, merchant.address]))
    assert.ok(all.every((d) => d.kind === 'recurring'))
    // Localnet keeps the plain getProgramAccounts (V2 paging is Helius only): same client, same answer.
    const plain = withPagedProgramAccounts(rpc, LOCALNET_RPC)
    assert.equal(plain, rpc)
    const scan = await new DelegationScans(plain).orLast(owner.address)
    assert.equal(scan.stale, false)
    assert.deepEqual(new Set(scan.list.map((d) => d.address)), new Set(all.map((d) => d.address)))
  })

  await t.test('revoke one of two: delegation closed, authority kept for the other', async () => {
    const r = await buildRevokeTx(rpc, owner.address, delegationPda, mint)
    assert.equal(r.revokesAuthority, false)
    assert.deepEqual(requiredSigners(r.transactionBase64), [owner.address])
    assertOk(await deviceSignAndSend(rpc, owner, r.transactionBase64))
    assert.equal((await readRecurring(rpc, delegationPda)).exists, false)
    assert.equal((await readAta(rpc, userAta)).delegate, authorityPda, 'the other mandate still works')
    const dead = await pull(1n)
    assert.ok(dead.err, 'pull on a revoked delegation fails')
  })

  await t.test('revoke the last: one transaction clears the SPL delegate too', async () => {
    const r = await buildRevokeTx(rpc, owner.address, merchantPda, mint)
    assert.equal(r.revokesAuthority, true)
    const l = assertOk(await deviceSignAndSend(rpc, owner, r.transactionBase64))
    console.log(`    revoke signature ${l.signature}`)
    const ata = await readAta(rpc, userAta)
    assert.equal(ata.delegate, null, 'userAta delegate: none')
    assert.equal((await listDelegations(rpc, owner.address)).length, 0)
    const dead = await pull(1n, merchant, () => merchantPda)
    assert.ok(dead.err)
  })
})
