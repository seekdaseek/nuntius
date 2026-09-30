import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { Executor, rpcChain } from './executor.js'
import { MandateStore } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
import { createLogger } from './log.js'
import { buildGrantTx, buildRevokeTx } from './mandate-chain.js'
import { PULL_BUDGET, priorityFeeLamports } from './tx.js'
import {
  assertOk,
  ataFor,
  deviceSignAndSend,
  funded,
  mintTo,
  requireLocal,
  skipLocalnet,
  sleep,
  tokenBalance,
} from './test/localnet.js'

test('executor against the real program', { skip: skipLocalnet, timeout: 120_000 }, async (t) => {
  const rpc = requireLocal()
  const owner = await funded(rpc)
  const delegatee = await funded(rpc)
  const payee = await funded(rpc)
  const { mint, ata: userAta } = await mintTo(rpc, owner, owner.address, 1_000_000n)
  const receiverAta = await ataFor(rpc, payee, mint, payee.address)
  const now = Math.floor(Date.now() / 1000)
  const period = 6

  const grant = await buildGrantTx(rpc, {
    owner: owner.address,
    mint,
    delegatee: delegatee.address,
    nonce: 0n,
    amountPerPeriod: 2_500n,
    periodLengthS: BigInt(period),
    startTs: 0n,
    expiryTs: BigInt(now + 3600),
  })
  assertOk(await deviceSignAndSend(rpc, owner, grant.transactionBase64))

  const store = new MandateStore(new Database(':memory:'))
  const pushes: string[] = []
  const push: PushPort = { toAddress: async (_a, m) => (pushes.push(m.title), [200]) }
  const lines: string[] = []
  const log = createLogger((l) => lines.push(l))
  const m = store.insertMandate(
    {
      address: owner.address,
      label: 'Gym',
      payee: payee.address,
      receiverAta,
      mint,
      symbol: 'TEST',
      decimals: 6,
      amountPerPeriod: '2500',
      pullAmount: '2500',
      periodLengthS: period,
      expiryTs: now + 3600,
      nonce: 0,
      delegatee: delegatee.address,
      delegationPda: grant.delegationPda,
      authorityPda: grant.authorityPda,
      userAta,
    },
    Date.now(),
  )
  store.setStatus(m.id, 'active', Date.now())
  const ex = new Executor({
    store,
    chain: rpcChain(rpc, delegatee),
    receipts: new Receipts(store, push, log, 'localnet'),
    log,
  })

  await t.test('first tick pulls the period amount; the payee receives it', async () => {
    assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
    assert.equal(await tokenBalance(rpc, receiverAta), 2_500n)
    assert.equal(await tokenBalance(rpc, userAta), 997_500n)
    assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' })
    assert.equal(await tokenBalance(rpc, receiverAta), 2_500n, 'no double pull')
  })

  await t.test('the pull carries a compute budget; the delegatee pays the small priority fee', async () => {
    const sig = store.pullsFor(grant.delegationPda).find((p) => p.state === 'landed')!.signature!
    const tx = await rpc
      .getTransaction(sig as never, { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' })
      .send()
    const used = Number(tx!.meta!.computeUnitsConsumed)
    assert.ok(used < PULL_BUDGET.unitLimit, `${used} units fit the ${PULL_BUDGET.unitLimit} limit`)
    assert.equal(priorityFeeLamports(PULL_BUDGET), 2_000n)
    assert.equal(BigInt(tx!.meta!.fee), 5_000n + 2_000n, 'base fee plus 2,000 lamports')
    console.log(`    pull: ${used} units, fee ${tx!.meta!.fee} lamports`)
  })

  await t.test('after the period rolls, it pulls again with no new user signature', async () => {
    await sleep((period + 1) * 1000)
    assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
    assert.equal(await tokenBalance(rpc, receiverAta), 5_000n)
  })

  await t.test('demo: one unit above what is left lands as a real 0x190 refusal and a receipt', async () => {
    const r = await ex.demoOverCap(store.getMandate(m.id)!)
    assert.equal(r.customCode, 400)
    console.log(`    refused on chain: ${r.signature}`)
    assert.equal(await tokenBalance(rpc, receiverAta), 5_000n, 'nothing moved')
    assert.ok(pushes.includes('Refused by the chain: Gym'))
  })

  await t.test('user revokes from the phone; the executor sees it and ends the mandate', async () => {
    const r = await buildRevokeTx(rpc, owner.address, grant.delegationPda, mint)
    assertOk(await deviceSignAndSend(rpc, owner, r.transactionBase64))
    assert.deepEqual(await ex.tick(), { [m.id]: 'revoked' })
    assert.equal(store.getMandate(m.id)!.status, 'revoked')
    assert.ok(pushes.includes('Revoked: Gym'))
    assert.equal(store.pullsFor(grant.delegationPda).filter((p) => p.state === 'landed').length, 2)
  })

  for (const l of lines) JSON.parse(l)
  console.log(`    pushes: ${pushes.join(' | ')}`)
})
