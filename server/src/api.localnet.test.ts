/**
 * The whole mandatum HTTP surface against the real program on a local
 * validator, exactly as the app drives it: the server builds, the "device"
 * signs the returned bytes, the server confirms against the chain.
 * SIWS itself is covered by selftest.ts; here sessions are created directly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.js'
import { openDb, Store } from './db.js'
import { MandateStore } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
import { Executor, rpcChain } from './executor.js'
import { createLogger } from './log.js'
import { buildGrantTx } from './mandate-chain.js'
import type { Config } from './config.js'
import {
  assertOk,
  ataFor,
  deviceSignAndSend,
  funded,
  LOCALNET_RPC,
  mintTo,
  requireLocal,
  skipLocalnet,
  sleep,
} from './test/localnet.js'

test('mandatum API end to end on the real program', { skip: skipLocalnet, timeout: 180_000 }, async (t) => {
  const rpc = requireLocal()
  const owner = await funded(rpc)
  const delegatee = await funded(rpc)
  const payee = await funded(rpc)
  const merchant = await funded(rpc)
  const { mint, ata: userAta } = await mintTo(rpc, owner, owner.address, 50_000_000n) // 50 TUSD
  await ataFor(rpc, payee, mint, payee.address)

  const db = openDb(':memory:')
  const store = new Store(db)
  const mandates = new MandateStore(db)
  const pushes: string[] = []
  const push: PushPort = { toAddress: async (_a, m) => (pushes.push(m.title), [200]) }
  const log = createLogger(() => {})
  const receipts = new Receipts(mandates, push, log, 'localnet')
  const executor = new Executor({ store: mandates, chain: rpcChain(rpc, delegatee), receipts, log })
  const cfg = {
    cluster: 'localnet' as const,
    rpcUrl: LOCALNET_RPC,
    mints: [{ symbol: 'TUSD', mint, decimals: 6 }],
    maxPerPeriodUi: '100',
    delegateePath: null,
    executorIntervalMs: 30_000,
    guardIntervalMs: 60_000,
    demoEndpoints: true,
  }
  const config = {
    port: 0,
    domain: 'localhost',
    heliusRpc: null,
    fcmServiceAccount: null,
    fcmProjectId: null,
  } as unknown as Config
  const app = createApp(config, store, null, undefined, {
    mandates,
    cfg,
    rpc,
    delegatee: delegatee.address,
    receipts,
    executor,
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  t.after(() => server.close())

  const seekerSession = 'S'.repeat(40) + 'eek'
  const basicSession = 'B'.repeat(40) + 'asc'
  store.createSession(seekerSession, owner.address, Date.now())
  store.claimSgtMint(seekerSession, 'Gv9AN58bVkqWp4w7dNc7nT3cJAavAH1VBi4fpESsCVZn')
  const call = async (path: string, body: Record<string, unknown>, session = seekerSession) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, ...body }),
    })
    return { status: r.status, json: (await r.json()) as Record<string, any> }
  }
  const terms = {
    label: 'Rent to Ana',
    payee: payee.address,
    symbol: 'TUSD',
    amount: '2.5',
    period: 'week',
    untilDays: 30,
  }
  // Weekly period starts before a 30-day expiry: days 0, 7, 14, 21, 28.
  const lifetimePeriods = 5

  await t.test('unauthenticated and malformed requests are refused', async () => {
    assert.equal((await call('/api/mandates/list', {}, 'x'.repeat(43))).status, 401)
    assert.equal((await call('/api/mandates/list', {}, 'short')).status, 400)
    assert.equal((await call('/api/mandates/preview', { ...terms, amount: '0.0000001' })).json.error, 'bad_amount')
    assert.equal((await call('/api/mandates/preview', { ...terms, amount: '101' })).json.error, 'over_beta_ceiling')
    assert.equal((await call('/api/mandates/preview', { ...terms, period: 'month' })).json.error, 'bad_period')
    assert.equal((await call('/api/mandates/preview', { ...terms, untilDays: 0 })).json.error, 'bad_until')
    assert.equal((await call('/api/mandates/preview', { ...terms, payee: owner.address })).json.error, 'bad_payee')
    assert.equal(
      (await call('/api/mandates/create', { ...terms, payee: merchant.address })).json.error,
      'payee_has_no_account',
    )
  })

  await t.test('preview: the sentence the user approves', async () => {
    const r = await call('/api/mandates/preview', terms)
    assert.equal(r.status, 200)
    assert.match(r.json.text.headline, /^Rent to Ana \(.{4}….{4}\) can receive up to 2\.5 TUSD every week, until /)
    assert.equal(r.json.amountBaseUnits, '2500000')
    // The approve screen quotes what the token allowance will be, before Seed Vault opens.
    assert.equal(r.json.lifetimeTotal, String(2.5 * lifetimePeriods))
    assert.equal(r.json.allowanceTotal, r.json.lifetimeTotal, 'no other delegation yet: the allowance is this one')
  })

  let mandateId = ''
  let pda = ''
  await t.test('create → one owner signature → confirm activates against the chain', async () => {
    const c = await call('/api/mandates/create', terms)
    assert.equal(c.status, 200, JSON.stringify(c.json))
    assert.equal(c.json.createsAuthority, true)
    assert.equal(c.json.allowanceTotal, String(2.5 * lifetimePeriods))
    // Confirming before it lands is refused.
    assert.equal((await call('/api/mandates/confirm', { mandateId: c.json.mandateId })).json.error, 'not_on_chain_yet')
    assertOk(await deviceSignAndSend(rpc, owner, c.json.transactionBase64))
    const f = await call('/api/mandates/confirm', { mandateId: c.json.mandateId })
    assert.equal(f.status, 200, JSON.stringify(f.json))
    assert.equal(f.json.mandate.status, 'active')
    assert.equal(f.json.mandate.remaining, '2.5')
    mandateId = c.json.mandateId
    pda = c.json.delegationPda
    assert.ok(pushes.includes('Permission live: Rent to Ana'))
  })

  await t.test('tier gate: a basic session gets one mandate, the guard stays free', async () => {
    store.createSession(basicSession, merchant.address, Date.now())
    const { mint: m2 } = await mintTo(rpc, merchant, merchant.address, 1_000_000n)
    void m2
    const l = await call('/api/mandates/list', {}, basicSession)
    assert.equal(l.status, 200, 'list works for basic')
    assert.equal(l.json.tier, 'basic')
    assert.equal(l.json.limits.maxActiveMandates, 1)
    assert.equal((await call('/api/clock-in', { tzOffsetMin: 180 }, basicSession)).json.error, 'tier_limit')
    // The Seeker session can open a second mandate.
    const p = await call('/api/mandates/preview', { ...terms, label: 'Gym' })
    assert.equal(p.json.allowed, true)
  })

  let foreignPda = ''
  await t.test('list shows our mandate AND a delegation another app holds', async () => {
    const g = await buildGrantTx(rpc, {
      owner: owner.address,
      mint,
      delegatee: merchant.address,
      nonce: 0n,
      amountPerPeriod: 1_000_000n,
      periodLengthS: 86_400n,
      startTs: 0n,
      expiryTs: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    })
    assertOk(await deviceSignAndSend(rpc, owner, g.transactionBase64))
    foreignPda = g.delegationPda
    const l = await call('/api/mandates/list', {})
    assert.equal(l.json.mine.length, 1)
    assert.equal(l.json.others.length, 1)
    assert.equal(l.json.others[0].delegatee, merchant.address)
    assert.equal(l.json.others[0].cap, '1')
    assert.equal(l.json.others[0].revocable, true)
    assert.equal(l.json.demo, true)
    assert.ok(l.json.tokenAccount.delegate, 'token account currently delegated to the authority PDA')
  })

  await t.test('executor pulls; the list and receipts show it; the demo refusal is the chain’s', async () => {
    // Confirm kicked the executor: the first pull is already out, well inside the
    // ~10 s the first pull should take (it took 53 s on mainnet on 30 Sep).
    const t0 = Date.now()
    let l = await call('/api/mandates/list', {})
    while (l.json.mine[0].remaining !== '0') {
      assert.ok(Date.now() - t0 < 10_000, 'the first pull follows the confirm within 10 s')
      await sleep(250)
      l = await call('/api/mandates/list', {})
    }
    assert.equal((await executor.tick())[mandateId], 'period_done', 'and is not pulled twice')
    const d = await call('/api/mandates/demo-overcap', { mandateId })
    assert.equal(d.json.refusedByChain, true)
    assert.equal(d.json.customCode, 400)
    const rc = await call('/api/receipts', {})
    const kinds = rc.json.receipts.map((x: { kind: string }) => x.kind)
    assert.deepEqual(kinds.slice(0, 3), ['refused', 'pull', 'granted'])
    assert.equal(rc.json.receipts[1].amount, '2.5')
    assert.match(rc.json.receipts[1].signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/)
    // The pull's receipt remembers what was left right after it, so the slip draws its meter.
    assert.equal(rc.json.receipts[1].cap, '2.5')
    assert.equal(rc.json.receipts[1].remaining, '0')
    assert.equal(rc.json.receipts[1].per, 604800)
    assert.ok(rc.json.receipts[1].reset > Date.now() / 1000, 'the reset is in the future')
  })

  await t.test('clock-in, digest and widget', async () => {
    const c = await call('/api/clock-in', { tzOffsetMin: 180 })
    assert.equal(c.json.streak.current, 1)
    assert.equal(c.json.firstToday, true)
    assert.equal(c.json.days.length, 1, 'punch-card days returned')
    assert.equal((await call('/api/clock-in', { tzOffsetMin: 180 })).json.firstToday, false)
    const g = await call('/api/digest', { tzOffsetMin: 180 })
    assert.equal(g.json.digest.title, '1 pull refused by the chain overnight')
    assert.equal(g.json.digest.totals.moved.TUSD, '2.5')
    assert.equal(g.json.streak.clockedInToday, true)
    const p = await call('/api/digest/prefs', { hour: 8, tzOffsetMin: 180 })
    assert.equal(p.json.prefs.hour, 8)
    const w = await call('/api/widget', { tzOffsetMin: 180 })
    assert.equal(w.json.liveCount, 2)
    assert.equal(w.json.streak, 1)
    assert.equal(w.json.lastReceipt.kind, 'refused')
  })

  await t.test('revoke a foreign delegation, then ours: one signature each, delegate: none at the end', async () => {
    const r1 = await call('/api/mandates/revoke', { delegationPda: foreignPda })
    assert.equal(r1.json.revokesAuthority, false, 'ours still needs the authority')
    assert.equal((await call('/api/mandates/revoke-confirm', { delegationPda: foreignPda })).json.error, 'still_live')
    assertOk(await deviceSignAndSend(rpc, owner, r1.json.transactionBase64))
    assert.equal((await call('/api/mandates/revoke-confirm', { delegationPda: foreignPda })).json.revoked, true)
    assert.ok(
      pushes.includes(`Revoked: ${merchant.address.slice(0, 4)}…${merchant.address.slice(-4)}`),
      'names the foreign delegatee',
    )

    const r2 = await call('/api/mandates/revoke', { delegationPda: pda })
    assert.equal(r2.json.revokesAuthority, true)
    assertOk(await deviceSignAndSend(rpc, owner, r2.json.transactionBase64))
    const done = await call('/api/mandates/revoke-confirm', { delegationPda: pda })
    assert.equal(done.json.tokenAccountDelegate, null, 'userAta delegate: none')
    const l = await call('/api/mandates/list', {})
    assert.equal(l.json.mine.length, 0)
    assert.equal(l.json.others.length, 0)
    assert.equal((await call('/api/mandates/revoke', { delegationPda: pda })).json.error, 'no_delegation')
    console.log(`    pushes: ${pushes.join(' | ')}`)
    void userAta
  })
})

test('digest scheduler sends once per local day, Seeker tier only', async () => {
  const { runDigests } = await import('./digest-scheduler.js')
  const db = openDb(':memory:')
  const store = new Store(db)
  const mandates = new MandateStore(db)
  const sent: string[] = []
  const deps = {
    store,
    mandates,
    push: { toAddress: async (a: string, m: { title: string }) => (sent.push(`${a}:${m.title}`), [200]) },
    log: createLogger(() => {}),
    live: async () => [],
  }
  store.createSession('A'.repeat(43), 'Seeker1111111111111111111111111111111111111', 0)
  store.claimSgtMint('A'.repeat(43), 'SgtMint')
  store.createSession('B'.repeat(43), 'Basic11111111111111111111111111111111111111', 0)
  mandates.setDigestPrefs('Seeker1111111111111111111111111111111111111', 8, 180, true)
  mandates.setDigestPrefs('Basic11111111111111111111111111111111111111', 8, 180, true)
  const at8 = Date.UTC(2026, 9, 1, 5) // 08:00 EEST
  assert.deepEqual(await runDigests(deps, at8 - 3600_000), [], 'before the hour')
  assert.deepEqual(await runDigests(deps, at8), ['Seeker1111111111111111111111111111111111111'])
  assert.deepEqual(await runDigests(deps, at8 + 60_000), [], 'once per day')
  assert.equal(sent[0], 'Seeker1111111111111111111111111111111111111:Quiet night, nothing moved')
  assert.deepEqual(await runDigests(deps, at8 + 24 * 3600_000), ['Seeker1111111111111111111111111111111111111'])
})
