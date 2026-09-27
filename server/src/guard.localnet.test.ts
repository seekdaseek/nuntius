import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { Guard, rpcGuardChain } from './guard.js'
import { MandateStore } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
import { createLogger } from './log.js'
import { buildGrantTx, buildRevokeTx, pullInstruction } from './mandate-chain.js'
import { signAndSend } from './tx.js'
import { assertOk, ataFor, deviceSignAndSend, funded, mintTo, requireLocal, skipLocalnet } from './test/localnet.js'

test('guard: receipts for delegations nuntius did not create', { skip: skipLocalnet, timeout: 120_000 }, async (t) => {
  const rpc = requireLocal()
  const owner = await funded(rpc)
  const merchant = await funded(rpc) // some other app's delegatee
  const stranger = await funded(rpc)
  const { mint, ata: userAta } = await mintTo(rpc, owner, owner.address, 1_000_000n)
  const merchantAta = await ataFor(rpc, merchant, mint, merchant.address)
  const expiryTs = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const grant = (delegatee: string, nonce: bigint) =>
    buildGrantTx(rpc, {
      owner: owner.address,
      mint,
      delegatee: delegatee as never,
      nonce,
      amountPerPeriod: 3_000n,
      periodLengthS: 3600n,
      startTs: 0n,
      expiryTs,
    })
  const merchantPull = async (pda: string, amount: bigint) =>
    signAndSend(rpc, merchant, [
      await pullInstruction({
        delegatee: merchant,
        delegationPda: pda as never,
        delegator: owner.address,
        delegatorAta: userAta,
        receiverAta: merchantAta,
        mint,
        amount,
      }),
    ])

  // The merchant's delegation exists before the user ever opens nuntius.
  const g1 = await grant(merchant.address, 7n)
  assertOk(await deviceSignAndSend(rpc, owner, g1.transactionBase64))

  const store = new MandateStore(new Database(':memory:'))
  const pushes: string[] = []
  const push: PushPort = { toAddress: async (_a, m) => (pushes.push(`${m.title} — ${m.body}`), [200]) }
  const log = createLogger(() => {})
  const guard = new Guard({
    store,
    chain: rpcGuardChain(rpc),
    receipts: new Receipts(store, push, log, 'localnet'),
    log,
    addresses: () => [owner.address],
    mintInfo: () => ({ symbol: 'USDC', decimals: 6 }),
  })

  await t.test('first scan is a silent baseline', async () => {
    const r = await guard.tick()
    assert.equal(r[0]!.events, 0)
    assert.equal(pushes.length, 0)
  })

  await t.test('a foreign delegatee pulls: receipt with the amount the chain recorded', async () => {
    assertOk(await merchantPull(g1.delegationPda, 1_250n))
    const r = await guard.tick()
    assert.equal(r[0]!.events, 1)
    const e = store.events(owner.address)[0]!
    assert.equal(e.kind, 'pull')
    assert.equal(e.actor, 'other')
    assert.equal(e.amountBaseUnits, '1250')
    assert.match(pushes.at(-1)!, /received 0.00125 USDC/)
  })

  await t.test('the foreign delegatee asks above the cap: a "refused by the chain" receipt', async () => {
    const l = await merchantPull(g1.delegationPda, 5_000n)
    assert.equal(l.customCode, 400)
    await guard.tick()
    const e = store.events(owner.address)[0]!
    assert.equal(e.kind, 'refused')
    assert.equal(e.signature, l.signature)
    assert.match(pushes.at(-1)!, /^Refused by the chain/)
  })

  let g2pda: string
  await t.test('a new permission appears that nuntius did not create: flagged', async () => {
    const g2 = await grant(stranger.address, 0n)
    assertOk(await deviceSignAndSend(rpc, owner, g2.transactionBase64))
    g2pda = g2.delegationPda
    await guard.tick()
    const e = store.events(owner.address)[0]!
    assert.equal(e.kind, 'granted')
    assert.equal(e.actor, 'other')
    assert.match(pushes.at(-1)!, /^New permission on your wallet/)
  })

  await t.test('revoked from anywhere: receipt, and the next scan is quiet', async () => {
    const r = await buildRevokeTx(rpc, owner.address, g2pda as never, mint)
    assertOk(await deviceSignAndSend(rpc, owner, r.transactionBase64))
    await guard.tick()
    assert.equal(store.events(owner.address)[0]!.kind, 'revoked')
    const who = `${stranger.address.slice(0, 4)}…${stranger.address.slice(-4)}`
    assert.equal(pushes.at(-1)!.split(' — ')[0], `Revoked: ${who}`, 'names the delegatee after its account is gone')
    const again = await guard.tick()
    assert.equal(again[0]!.events, 0, 'no duplicate receipts')
    console.log(`    receipts: ${pushes.map((p) => p.split(' — ')[0]).join(' | ')}`)
  })
})
