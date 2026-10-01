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
    // A random seed: not the address the old counter gave the first grant.
    const counterPda = (
      await buildGrantTx(rpc, {
        owner: owner.address,
        mint,
        delegatee: delegatee.address,
        nonce: 0n,
        amountPerPeriod: 1n,
        periodLengthS: 3600n,
        startTs: 0n,
        expiryTs: BigInt(Math.floor(Date.now() / 1000) + 3600),
      })
    ).delegationPda
    assert.notEqual(pda, counterPda)
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
    assert.equal(g.json.digest.title, '1 pull refused by the chain in the last 24 hours')
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

  await t.test('rebuild: a fresh blockhash for a pending grant, and it cannot grant twice', async () => {
    const c = await call('/api/mandates/create', { ...terms, label: 'Gym' })
    assert.equal(c.status, 200, JSON.stringify(c.json))
    await sleep(1_000) // a new blockhash
    const r = await call('/api/mandates/rebuild', { mandateId: c.json.mandateId })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.notEqual(r.json.transactionBase64, c.json.transactionBase64)
    assert.equal(r.json.delegationPda, c.json.delegationPda, 'the same permission')
    assertOk(await deviceSignAndSend(rpc, owner, r.json.transactionBase64))
    assert.equal((await call('/api/mandates/confirm', { mandateId: c.json.mandateId })).json.mandate.status, 'active')
    // The first copy, signed late, is refused by the program: the delegation account exists.
    const late = await deviceSignAndSend(rpc, owner, c.json.transactionBase64).catch((e: unknown) => ({ err: e }))
    assert.notEqual(late.err, null)
    assert.equal((await call('/api/mandates/rebuild', { mandateId: c.json.mandateId })).json.error, 'not_pending')
    assert.equal((await call('/api/mandates/rebuild', { mandateId: 'nope' })).json.error, 'no_mandate')
    assert.equal(
      (await call('/api/mandates/rebuild', { mandateId: c.json.mandateId }, basicSession)).json.error,
      'no_mandate',
      "someone else's permission",
    )
    // The feed: only the live permission, since its grant. "Rent to Ana" (revoked)
    // and the other app's delegation are dated sections of their own.
    const rc = await call('/api/receipts', {})
    assert.ok(rc.json.receipts.length > 0)
    assert.ok(
      rc.json.receipts.every((x: { mandateId: string | null }) => x.mandateId === c.json.mandateId),
      'home lists Gym only',
    )
    const ended = rc.json.ended.map((x: { label: string; receipts: { kind: string }[] }) => [
      x.label,
      x.receipts[0]!.kind,
    ])
    assert.ok(
      ended.some(([l, k]: [string, string]) => l === 'Rent to Ana' && k === 'revoked'),
      JSON.stringify(ended),
    )
  })
})

test('digest scheduler sends once per local day, Seeker tier only', async () => {
  const { runDigests } = await import('./digest-scheduler.js')
  const db = openDb(':memory:')
  const store = new Store(db)
  const mandates = new MandateStore(db)
  const sent: string[] = []
  const urls: string[] = []
  const deps = {
    store,
    mandates,
    push: {
      toAddress: async (a: string, m: { title: string; url: string }) => (
        sent.push(`${a}:${m.title}`),
        urls.push(m.url),
        [200]
      ),
    },
    log: createLogger(() => {}),
    live: async () => [],
  }
  store.createSession('A'.repeat(43), 'Seeker1111111111111111111111111111111111111', 0)
  store.claimSgtMint('A'.repeat(43), 'SgtMint')
  store.createSession('B'.repeat(43), 'Basic11111111111111111111111111111111111111', 0)
  mandates.setDigestPrefs('Seeker1111111111111111111111111111111111111', 8, 180, true, 0)
  mandates.setDigestPrefs('Basic11111111111111111111111111111111111111', 8, 180, true, 0)
  const at8 = Date.UTC(2026, 9, 1, 5) // 08:00 EEST
  assert.deepEqual(await runDigests(deps, at8 - 3600_000), [], 'before the hour')
  assert.deepEqual(await runDigests(deps, at8), ['Seeker1111111111111111111111111111111111111'])
  assert.deepEqual(await runDigests(deps, at8 + 60_000), [], 'once per day')
  assert.equal(sent[0], 'Seeker1111111111111111111111111111111111111:Nothing moved in the last 24 hours')
  assert.deepEqual(await runDigests(deps, at8 + 24 * 3600_000), ['Seeker1111111111111111111111111111111111111'])
  assert.equal(sent[1], 'Seeker1111111111111111111111111111111111111:Nothing moved since your last digest')
  // Each digest's url carries its send time, so the app never takes the second
  // day's tap for a repeat of the first.
  assert.deepEqual(urls, [`/digest?source=digest&at=${at8}`, `/digest?source=digest&at=${at8 + 24 * 3600_000}`])
  assert.notEqual(urls[0], urls[1])
  // A refusal before a digest is in that digest only; the next counts from it.
  const refusal = (at: number, sig: string) =>
    mandates.addEvent('Seeker1111111111111111111111111111111111111', {
      kind: 'refused',
      at,
      delegationPda: 'ForeignPda',
      delegatee: 'D',
      label: 'Gym',
      amountBaseUnits: null,
      decimals: 6,
      symbol: 'USDC',
      signature: sig,
      actor: 'other',
    })
  refusal(at8 + 30 * 3600_000, 'r1') // between the 2nd and 3rd digest
  assert.deepEqual(await runDigests(deps, at8 + 48 * 3600_000), ['Seeker1111111111111111111111111111111111111'])
  assert.equal(
    sent[2],
    'Seeker1111111111111111111111111111111111111:1 pull refused by the chain since your last digest',
  )
  refusal(at8 + 60 * 3600_000, 'r2')
  assert.deepEqual(await runDigests(deps, at8 + 72 * 3600_000), ['Seeker1111111111111111111111111111111111111'])
  assert.equal(
    sent[3],
    'Seeker1111111111111111111111111111111111111:1 pull refused by the chain since your last digest',
    'r1, 42 hours old, is not counted again',
  )
})

test('digest: a UTC+3 user who sets 19:00 at 18:39 gets one digest at 19:00, none before', async () => {
  const { runDigests } = await import('./digest-scheduler.js')
  const db = openDb(':memory:')
  const store = new Store(db)
  const mandates = new MandateStore(db)
  const sent: number[] = []
  let clock = 0
  const deps = {
    store,
    mandates,
    push: { toAddress: async () => (sent.push(clock), [200]) },
    log: createLogger(() => {}),
    live: async () => [],
  }
  const who = 'Seeker1111111111111111111111111111111111111'
  store.createSession('A'.repeat(43), who, 0)
  store.claimSgtMint('A'.repeat(43), 'SgtMint')
  const local = (h: number, m: number) => Date.UTC(2026, 8, 30, h - 3, m) // UTC+3
  // As on 30 Sep: the picker saved every hour it passed on the way to 19, and
  // the scheduler's minute tick fell between two presses (15:39:31Z).
  mandates.setDigestPrefs(who, 8, 180, true, local(18, 39))
  clock = local(18, 39) + 5_000
  await runDigests(deps, clock)
  mandates.setDigestPrefs(who, 18, 180, true, local(18, 39) + 10_000)
  clock = local(18, 39) + 15_000
  await runDigests(deps, clock)
  mandates.setDigestPrefs(who, 19, 180, true, local(18, 39) + 20_000)
  // Then every minute to 19:30 local.
  for (let t = local(18, 39) + 30_000; t <= local(19, 30); t += 60_000) {
    clock = t
    await runDigests(deps, t)
  }
  assert.deepEqual(
    sent.map((t) => new Date(t).toISOString()),
    ['2026-09-30T16:00:30.000Z'],
    'one digest, in the first minute of 19:00 local (16:00Z)',
  )
  // Tomorrow it comes at 19:00 again.
  sent.length = 0
  for (let t = local(18, 30) + 86_400_000; t <= local(19, 5) + 86_400_000; t += 60_000) {
    clock = t
    await runDigests(deps, t)
  }
  assert.equal(sent.length, 1)
  assert.equal(new Date(sent[0]!).getUTCHours(), 16)
})
