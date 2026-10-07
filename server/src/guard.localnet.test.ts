import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { Guard, rpcGuardChain } from './guard.js'
import { MandateStore } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
import { createLogger } from './log.js'
import { buildGrantTx, buildRevokeTx, pullInstruction } from './mandate-chain.js'
import {
  assertOk,
  ataFor,
  deviceSignAndSend,
  funded,
  landWire,
  mintTo,
  requireLocal,
  signAndLand,
  skipLocalnet,
} from './test/localnet.js'
import { latestBlockhash, signOnly, waitFor } from './tx.js'

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
  // The foreign merchant's own sends: its over-cap pull must land for the guard to see it.
  const merchantPull = async (pda: string, amount: bigint) =>
    signAndLand(rpc, merchant, [
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

  await t.test('a new permission at an old address gets only its own history', async () => {
    // 30 Sep: a new permission's PDA had existed on 22 Sep (same delegator,
    // delegatee and seed), and the old pulls and refusals went out as new.
    // g1 has a pull and a refusal behind it; end it, then grant the same seed.
    const r = await buildRevokeTx(rpc, owner.address, g1.delegationPda, mint)
    assertOk(await deviceSignAndSend(rpc, owner, r.transactionBase64))
    // A server that never saw that history (as the live one had not).
    const store2 = new MandateStore(new Database(':memory:'))
    const pushes2: string[] = []
    const guard2 = new Guard({
      store: store2,
      chain: rpcGuardChain(rpc),
      receipts: new Receipts(store2, { toAddress: async (_a, m) => (pushes2.push(m.title), [200]) }, log, 'localnet'),
      log,
      addresses: () => [owner.address],
      mintInfo: () => ({ symbol: 'USDC', decimals: 6 }),
    })
    await guard2.tick() // baseline: the old account is closed, nothing live
    const again = await grant(merchant.address, 7n)
    assert.equal(again.delegationPda, g1.delegationPda, 'the same address as before')
    assertOk(await deviceSignAndSend(rpc, owner, again.transactionBase64))
    const fresh = await merchantPull(again.delegationPda, 1_000n)
    assertOk(fresh)
    await guard2.tick()
    const events = store2.events(owner.address)
    const kinds = events.map((e) => `${e.kind}:${e.amountBaseUnits ?? ''}`).sort()
    assert.deepEqual(kinds, ['granted:3000', 'pull:1000'], 'the new grant and its one pull, nothing from before')
    assert.equal(events.find((e) => e.kind === 'pull')!.signature, fresh.signature)
    assert.equal(pushes2.length, 2)
    assert.equal((await guard2.tick())[0]!.events, 0, 'and nothing twice')
  })
})

test(
  "guard: a backing's delegatee key used outside the executor gets a receipt saying so; the executor's own send gets none",
  { skip: skipLocalnet, timeout: 120_000 },
  async () => {
    const rpc = requireLocal()
    const owner = await funded(rpc)
    const key = await funded(rpc) // stands in for nuntius's executor key
    const { mint, ata: userAta } = await mintTo(rpc, owner, owner.address, 1_000_000n)
    const receiverAta = await ataFor(rpc, key, mint, key.address)
    const expiryTs = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const g = await buildGrantTx(rpc, {
      owner: owner.address,
      mint,
      delegatee: key.address,
      nonce: 3n,
      amountPerPeriod: 3_000n,
      periodLengthS: 3600n,
      startTs: 0n,
      expiryTs,
    })
    assertOk(await deviceSignAndSend(rpc, owner, g.transactionBase64))
    // nuntius's record of it: a backing, whose pulls are its buys.
    const store = new MandateStore(new Database(':memory:'))
    const created = Date.now() - 60_000
    const m = store.insertMandate(
      {
        address: owner.address,
        label: 'Back WEBT',
        payee: key.address,
        receiverAta,
        mint,
        symbol: 'USDC',
        decimals: 6,
        amountPerPeriod: '3000',
        pullAmount: '1000',
        periodLengthS: 3600,
        expiryTs: Number(expiryTs),
        nonce: 3,
        delegatee: key.address,
        delegationPda: g.delegationPda,
        authorityPda: 'Auth',
        userAta,
      },
      created,
    )
    store.setStatus(m.id, 'active', created)
    store.setBacking({
      mandateId: m.id,
      pool: 'Pool',
      route: 'dbc',
      dammPool: null,
      baseMint: 'Base',
      baseSymbol: 'WEBT',
      baseDecimals: 6,
      backerBaseAta: 'BackerBase',
      slippageBps: 200,
    })
    const pushes: string[] = []
    const log = createLogger(() => {})
    const guard = new Guard({
      store,
      chain: rpcGuardChain(rpc),
      receipts: new Receipts(store, { toAddress: async (_a, msg) => (pushes.push(msg.title), [200]) }, log, 'localnet'),
      log,
      addresses: () => [owner.address],
      mintInfo: () => ({ symbol: 'USDC', decimals: 6 }),
    })
    await guard.tick() // the silent baseline
    const pull = async () =>
      pullInstruction({
        delegatee: key,
        delegationPda: g.delegationPda,
        delegator: owner.address,
        delegatorAta: userAta,
        receiverAta,
        mint,
        amount: 1_000n,
      })
    // The executor's way: the signature is stored before the transaction is sent.
    const signed = await signOnly(key, [await pull()], await latestBlockhash(rpc))
    store.claimPull(
      {
        mandateId: m.id,
        delegationPda: g.delegationPda,
        periodStart: 0,
        amount: '1000',
        signature: signed.signature,
        lastValidBlockHeight: String(signed.lastValidBlockHeight),
      },
      Date.now(),
    )
    await landWire(rpc, signed.wire)
    assertOk(await waitFor(rpc, signed.signature, signed.lastValidBlockHeight, 30_000))
    await guard.tick()
    assert.deepEqual(
      store.events(owner.address).filter((e) => e.kind === 'pull'),
      [],
      'the executor writes that receipt',
    )
    assert.equal(pushes.length, 0)
    // The same key, not through the executor: the program lets it pull (to any receiver).
    const foreign = assertOk(await signAndLand(rpc, key, [await pull()]))
    await guard.tick()
    const pulls = store.events(owner.address).filter((e) => e.kind === 'pull')
    assert.equal(pulls.length, 1)
    assert.equal(pulls[0]!.signature, foreign.signature)
    assert.equal(pulls[0]!.note, 'not_sent_by_nuntius')
    assert.deepEqual(pushes, ['Not sent by nuntius: 0.001 USDC pulled on Back WEBT'])
    assert.equal((await guard.tick())[0]!.events, 0, 'nothing twice')
  },
)
