// Back permissions through the executor (BRIEF-DBC): each period's pull buys the launch token
// in the same transaction. Driven through the ChainPort fake; no Meteora program code anywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { buyJitterS, Executor } from './executor.js'
import { MandateStore } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
import { buildDigest, oneReceiptPerTransaction, type LedgerEvent } from './digest.js'
import { createLogger } from './log.js'
import { FakeChain } from './test/fake-chain.js'

const PDA = 'PdaBack1111111111111111111111111111111111111'
const DELEGATEE = 'DeLegatee1111111111111111111111111111111111'
const OWNER = 'Backer11111111111111111111111111111111111111'

function setup() {
  const chain = new FakeChain()
  const store = new MandateStore(new Database(':memory:'))
  const pushes: { title: string; body: string; url: string }[] = []
  const push: PushPort = {
    async toAddress(_a, msg) {
      pushes.push(msg)
      return [200]
    },
  }
  const lines: string[] = []
  const log = createLogger((l) => lines.push(l))
  const receipts = new Receipts(store, push, log, 'mainnet')
  let nowMs = Number(chain.nowS) * 1000
  const clock = {
    now: () => nowMs,
    advance(s: number) {
      nowMs += s * 1000
      chain.nowS += BigInt(s)
    },
  }
  // A week-long period, so the send jitter (up to 10 minutes) is in play.
  chain.add(PDA, {
    delegatee: DELEGATEE,
    delegator: OWNER,
    mint: 'USDC',
    amountPerPeriod: 1_000_000n,
    periodStart: chain.nowS,
    periodLength: 604_800n,
    expiry: 0n,
  })
  const m = store.insertMandate(
    {
      address: OWNER,
      label: 'Back NATX',
      payee: DELEGATEE,
      receiverAta: 'DelegateeUsdcAta',
      mint: 'USDC',
      symbol: 'USDC',
      decimals: 6,
      amountPerPeriod: '1000000',
      pullAmount: '1000000',
      periodLengthS: 604_800,
      expiryTs: 0,
      nonce: 0,
      delegatee: DELEGATEE,
      delegationPda: PDA,
      authorityPda: 'Auth',
      userAta: 'BackerUsdcAta',
    },
    nowMs,
  )
  store.setStatus(m.id, 'active', nowMs)
  store.setBacking({
    mandateId: m.id,
    pool: 'DbcPool',
    route: 'dbc',
    dammPool: null,
    baseMint: 'NatxMint',
    baseSymbol: 'NATX',
    baseDecimals: 6,
    backerBaseAta: 'BackerNatxAta',
    slippageBps: 200,
  })
  const mk = () =>
    new Executor({
      store,
      chain,
      receipts,
      log,
      now: clock.now,
      settleMs: 0,
      sleep: async () => {},
      random: () => 1,
      backoffBaseMs: 1_000,
    })
  const jitter = buyJitterS(m.id, Number(chain.nowS), 604_800)
  return { chain, store, pushes, lines, clock, m, mk, jitter, receipts }
}

test('a buy waits for its jittered moment, then pulls and buys in one transaction; the executor keeps nothing', async () => {
  const { chain, store, pushes, clock, m, mk, jitter } = setup()
  const ex = mk()
  assert.ok(jitter >= 0 && jitter < 600, `jitter ${jitter}s is inside the first 10 minutes`)
  if (jitter > 0) assert.deepEqual(await ex.tick(), { [m.id]: 'not_started' })
  clock.advance(jitter)
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  assert.equal(chain.sent.length, 1)
  assert.equal(chain.delegateeQuote, 0n, 'custody: the executor holds the same quote balance after the buy')
  assert.equal(chain.delegateeBase, 0n, 'custody: the executor never holds the launch token')
  assert.equal(chain.backerBase, 1_000_000_000n, 'the tokens went to the backer')
  const e = store.events(OWNER)[0]!
  assert.equal(e.kind, 'buy')
  assert.equal(e.outBaseUnits, '1000000000')
  assert.equal(e.outSymbol, 'NATX')
  assert.equal(pushes[0]!.title, 'Bought 1000 NATX for 1 USDC')
  assert.match(pushes[0]!.body, /Delivered to your own account/)
  // Idempotent: the period is done however many ticks follow.
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' })
  assert.equal(chain.sent.length, 1)
})

test('a buy that misses its minimum-out is skipped: nothing pulled, one receipt, retried later in the period', async () => {
  const { chain, store, pushes, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.swapFailures = 1
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped' })
  assert.equal(chain.delegations.get(PDA)!.pulled, 0n, 'the pull failed with the swap: nothing was taken')
  assert.equal(chain.backerBase, 0n)
  const row = store.pullsFor(PDA)[0]!
  assert.equal(row.state, 'skipped')
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0]!.title, 'Skipped: Back NATX')
  assert.equal(pushes[0]!.body, 'The price moved more than 2%. Nothing was taken.')
  // Before its backoff: no new attempt.
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped' })
  clock.advance(5)
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  assert.equal(store.pullsFor(PDA).length, 1, 'still one ledger row for the period')
  assert.equal(store.pullsFor(PDA)[0]!.attempts, 2)
  assert.equal(chain.delegations.get(PDA)!.pulled, 1_000_000n)
  assert.equal(chain.delegateeQuote, 0n)
  // A second skip in the same period would not push again: one skip receipt per period.
  assert.equal(store.events(OWNER).filter((e) => e.kind === 'skipped').length, 1)
})

test('a swap our simulation says would miss is skipped before it is sent: no fee, the same receipt', async () => {
  const { chain, store, pushes, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.simRefusals.push({ err: '{"InstructionError":[3,{"Custom":6002}]}', customCode: 6002 })
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped' })
  assert.deepEqual(chain.sends, [], 'never sent')
  assert.equal(store.pullsFor(PDA)[0]!.state, 'skipped')
  assert.equal(pushes[0]!.title, 'Skipped: Back NATX')
  clock.advance(5)
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' }, 'tried again later with a fresh quote')
  assert.deepEqual(chain.simulations.length, 2)
})

test('while the curve migrates the executor waits: no ledger row, no pull', async () => {
  const { chain, store, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.buyWait = 'migrating'
  assert.deepEqual(await mk().tick(), { [m.id]: 'buy_waiting' })
  assert.equal(store.pullsFor(PDA).length, 0)
  assert.equal(chain.sends.length, 0)
})

test('the route follows the token to DAMM v2 after migration', async () => {
  const { chain, store, lines, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.buyRoute = 'damm_v2'
  chain.dammPool = 'DammPool'
  assert.deepEqual(await mk().tick(), { [m.id]: 'landed' })
  const b = store.backingOf(m.id)!
  assert.equal(b.route, 'damm_v2')
  assert.equal(b.dammPool, 'DammPool')
  assert.ok(lines.some((l) => l.includes('executor_route_switch')))
})

test('a period already used through another path is not bought into', async () => {
  const { chain, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.delegations.get(PDA)!.pulled = 1n // the period is already used through another path
  assert.deepEqual(await mk().tick(), { [m.id]: 'cap_already_used' })
})

test('jitter: fixed per permission and period, at most a tenth of the period and 10 minutes', () => {
  assert.equal(buyJitterS('a', 1000, 604_800), buyJitterS('a', 1000, 604_800))
  for (let p = 0; p < 50; p++) {
    assert.ok(buyJitterS(`m${p}`, p * 60, 60) < 6)
    assert.ok(buyJitterS(`m${p}`, p * 604_800, 604_800) < 600)
  }
  assert.equal(buyJitterS('a', 0, 5), 0)
})

// --- A5b: each swap-leg failure gets its own receipt and retry rule ---------------------

const refuse = (code: number) => ({ err: `{"InstructionError":[3,{"Custom":${code}}]}`, customCode: code })

test('the curve completed first (6013): one receipt, nothing while it migrates, then the same period buys on DAMM v2', async () => {
  const { chain, store, pushes, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.simRefusals.push(refuse(6013))
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped' })
  assert.deepEqual(chain.sends, [], 'never sent: our simulation refused it')
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0]!.title, 'Skipped: Back NATX')
  assert.match(pushes[0]!.body, /^The curve filled before this buy\. Nothing was taken; it buys in the regular pool/)
  assert.doesNotMatch(pushes[0]!.body, /price moved/)
  assert.equal(store.events(OWNER)[0]!.note, 'curve_full')
  assert.match(pushes[0]!.url, /why=curve_full/)
  // While the curve migrates: nothing is built, simulated or sent, and no attempt is spent.
  chain.buyWait = 'migrating'
  clock.advance(60)
  assert.deepEqual(await ex.tick(), { [m.id]: 'buy_waiting' })
  assert.deepEqual(await ex.tick(), { [m.id]: 'buy_waiting' })
  assert.equal(chain.simulations.length, 1)
  assert.equal(store.pullsFor(PDA)[0]!.attempts, 1)
  // Migrated: the same period buys in the canonical DAMM v2 pool.
  chain.buyWait = null
  chain.buyRoute = 'damm_v2'
  chain.dammPool = 'DammPool'
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  const rows = store.pullsFor(PDA)
  assert.equal(rows.length, 1, 'still one ledger row for the period')
  assert.equal(rows[0]!.attempts, 2)
  assert.equal(rows[0]!.state, 'landed')
  assert.equal(store.backingOf(m.id)!.route, 'damm_v2')
  assert.equal(chain.delegations.get(PDA)!.pulled, 1_000_000n, 'one pull this period')
  assert.equal(chain.delegateeQuote, 0n)
  assert.deepEqual(
    store
      .events(OWNER)
      .map((e) => e.kind)
      .sort(),
    ['buy', 'skipped'],
    'the skip receipt, then the buy receipt',
  )
  // Idempotent: the period is done.
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' })
  assert.equal(chain.sent.length, 1)
})

test('after 6013, a route that is still the curve is not bought: only the migrated pool is', async () => {
  const { chain, store, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.simRefusals.push(refuse(6013))
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped' })
  clock.advance(60)
  assert.deepEqual(await ex.tick(), { [m.id]: 'buy_waiting' }, 'a DBC quote is not taken after the curve completed')
  assert.equal(store.pullsFor(PDA)[0]!.attempts, 1)
  assert.equal(chain.sends.length, 0)
})

test('less room than quoted (6033): re-quoted one unit smaller at once, with no receipt for the miss', async () => {
  const { chain, store, pushes, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.simRefusals.push(refuse(6033))
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped' })
  assert.equal(pushes.length, 0, 'no receipt for a miss that is retried at once')
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' }, 'the next tick, with no backoff')
  const row = store.pullsFor(PDA)[0]!
  assert.equal(row.amount, '999999', 'one base unit under the amount that failed')
  assert.equal(chain.delegations.get(PDA)!.pulled, 999_999n, 'the pull took only what the buy spent')
  assert.equal(chain.delegateeQuote, 0n)
  assert.equal(pushes.length, 1)
  assert.match(pushes[0]!.title, /^Bought /)
})

test('no room twice: one receipt that names it, and no more tries this period', async () => {
  const { chain, store, pushes, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.simRefusals.push(refuse(6033), refuse(6033))
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped' })
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped' })
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0]!.body, 'The curve had less room left than quoted. Nothing was taken.')
  assert.equal(store.events(OWNER)[0]!.note, 'no_room')
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' })
  assert.equal(chain.simulations.length, 2)
})

test('any other program error is named by its code, not called slippage, and not retried', async () => {
  const { chain, store, pushes, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.simRefusals.push(refuse(6043))
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped' })
  assert.equal(pushes[0]!.body, 'The swap failed with error 6043. Nothing was taken.')
  assert.equal(store.events(OWNER)[0]!.note, 'error:6043')
  clock.advance(3_600)
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' })
})

test('a landed failure is classified the same way as a simulated one (6013 on chain)', async () => {
  const { chain, store, pushes, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.swapFailures = 1
  chain.swapFailureCode = 6013
  assert.deepEqual(await mk().tick(), { [m.id]: 'skipped' })
  assert.equal(chain.delegations.get(PDA)!.pulled, 0n, 'nothing was taken')
  assert.match(pushes[0]!.body, /curve filled/)
  assert.equal(store.pullsFor(PDA)[0]!.error, 'swap_curve_full')
})

test('on DAMM v2, 6023 is "no room" and 6002 is slippage; 6013 there is just an error code', async () => {
  const { chain, store, clock, m, mk, jitter } = setup()
  clock.advance(jitter)
  chain.buyRoute = 'damm_v2'
  chain.dammPool = 'DammPool'
  chain.simRefusals.push(refuse(6023))
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped' })
  assert.equal(store.pullsFor(PDA)[0]!.error, 'swap_no_room')
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
})

test("one transaction, one receipt, one push, in the buy's words, whichever side records it first", async () => {
  const { store, pushes, lines, receipts, clock } = setup()
  const base = {
    at: clock.now(),
    delegationPda: PDA,
    delegatee: DELEGATEE,
    label: 'Back NATX',
    amountBaseUnits: '1000000',
    decimals: 6,
    symbol: 'USDC',
    actor: 'nuntius' as const,
  }
  const buy = (signature: string): LedgerEvent => ({
    ...base,
    kind: 'buy',
    signature,
    outBaseUnits: '26716209842',
    outDecimals: 6,
    outSymbol: 'NATX',
  })
  const pull = (signature: string): LedgerEvent => ({ ...base, kind: 'pull', signature })
  const rows = (sig: string) => store.events(OWNER).filter((e) => e.signature === sig)
  // The usual order (7 Oct, 4Ycn6Yfp…): the executor's buy, then the guard's view of the same debit.
  assert.equal(await receipts.emit(OWNER, buy('SigA')), true)
  assert.equal(await receipts.emit(OWNER, pull('SigA')), false)
  assert.deepEqual(
    rows('SigA').map((e) => e.kind),
    ['buy'],
  )
  assert.equal(pushes.length, 1)
  // The other order: the pull was recorded and pushed first; the buy takes its row, with no second push.
  assert.equal(await receipts.emit(OWNER, pull('SigB')), true)
  assert.equal(await receipts.emit(OWNER, buy('SigB')), false)
  assert.deepEqual(
    rows('SigB').map((e) => [e.kind, e.outSymbol]),
    [['buy', 'NATX']],
  )
  assert.equal(pushes.length, 2)
  assert.match(lines.join('\n'), /"event":"receipt_upgraded"/)
  // Another transaction is another receipt.
  assert.equal(await receipts.emit(OWNER, pull('SigC')), true)
  assert.equal(pushes.length, 3)
  // Rows written before the fix hold both: the receipts list and the digest count the buy once.
  store.addEvent(OWNER, pull('SigOld'))
  store.addEvent(OWNER, buy('SigOld'))
  const listed = oneReceiptPerTransaction(store.events(OWNER)).filter((e) => e.signature === 'SigOld')
  assert.deepEqual(
    listed.map((e) => e.kind),
    ['buy'],
  )
})

test('the digest counts transactions: a buy and its old pull row are one, and a buy is money moved', () => {
  const at = 10_000
  const ev = (kind: 'pull' | 'buy', signature: string, amount: string, symbol: string, label: string): LedgerEvent => ({
    kind,
    at,
    delegationPda: PDA,
    delegatee: DELEGATEE,
    label,
    amountBaseUnits: amount,
    decimals: 6,
    symbol,
    signature,
    actor: 'nuntius',
    ...(kind === 'buy' ? { outBaseUnits: '133597335115', outDecimals: 6, outSymbol: 'NIMUS' } : {}),
  })
  const d = buildDigest(
    [
      ev('buy', 'Sig1', '5000000', 'SKR', 'Back NIMUS'),
      ev('pull', 'Sig1', '5000000', 'SKR', 'Back NIMUS'),
      ev('pull', 'Sig2', '50000', 'USDC', 'Ana'),
    ],
    [],
    at + 1,
  )
  assert.equal(d.totals.pulls, 2)
  assert.deepEqual(d.totals.moved, { SKR: '5', USDC: '0.05' })
  assert.deepEqual(d.lines, ['Back NIMUS: 5 SKR bought NIMUS.', 'Ana received 0.05 USDC.'])
  assert.equal(d.title, '2 pulls in the last 24 hours: 5 SKR and 0.05 USDC moved')
})
