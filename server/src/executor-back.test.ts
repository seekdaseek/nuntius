// Back permissions through the executor (BRIEF-DBC): each period's pull buys the launch token
// in the same transaction. Driven through the ChainPort fake; no Meteora program code anywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { buyJitterS, Executor } from './executor.js'
import { MandateStore } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
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
  return { chain, store, pushes, lines, clock, m, mk, jitter }
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
