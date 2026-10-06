// The committed-demand feed: numbers from the store, own wallets kept out of the third-party
// figures, and the stream hearing each buy and each migration once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import express from 'express'
import Database from 'better-sqlite3'
import { MandateStore } from './mandate-store.js'
import { commitmentSentence, FeedBus, feedFromDb, registerFeedRoutes, type FeedEvent } from './launch-feed.js'
import { buyJitterS } from './executor.js'
import { RateLimiter } from './rate-limit.js'

const OWN = 'Own1111111111111111111111111111111111111111'
const ANA = 'Ana11111111111111111111111111111111111111111'
const BOB = 'Bob11111111111111111111111111111111111111111'
const POOL = 'Pool111111111111111111111111111111111111111'

function seed() {
  const db = new Database(':memory:')
  const store = new MandateStore(db)
  const backer = (address: string, n: number, amount: string, periodLengthS: number) => {
    const m = store.insertMandate(
      {
        address,
        label: `Back PROOF ${n}`,
        payee: 'Executor',
        receiverAta: 'ExecSkr',
        mint: 'SKR',
        symbol: 'SKR',
        decimals: 6,
        amountPerPeriod: amount,
        pullAmount: amount,
        periodLengthS,
        expiryTs: 0,
        nonce: n,
        delegatee: 'Executor',
        delegationPda: `Pda${n}`,
        authorityPda: `Auth${n}`,
        userAta: `Ata${n}`,
      },
      1_000,
    )
    store.setStatus(m.id, 'active', 1_000)
    store.setBacking({
      mandateId: m.id,
      pool: POOL,
      route: 'dbc',
      dammPool: null,
      baseMint: 'ProofMint',
      baseSymbol: 'PROOF',
      baseDecimals: 6,
      backerBaseAta: `Base${n}`,
      slippageBps: 200,
    })
    return m
  }
  const own = backer(OWN, 1, '50000000', 3_600) // 50 SKR an hour
  const ana = backer(ANA, 2, '25000000', 604_800) // 25 SKR a week
  const bob = backer(BOB, 3, '10000000', 86_400) // 10 SKR a day
  const pull = (mandateId: string, pda: string, period: number, amount: string, sig: string) => {
    store.claimPull(
      { mandateId, delegationPda: pda, periodStart: period, amount, signature: sig, lastValidBlockHeight: '1' },
      2_000 + period,
    )
    const row = store.getPull(pda, period)!
    store.finishPull(row.id, 'landed', null, null, 2_000 + period)
  }
  pull(own.id, 'Pda1', 1, '50000000', 'sigOwn')
  pull(ana.id, 'Pda2', 1, '25000000', 'sigAna')
  pull(bob.id, 'Pda3', 1, '10000000', 'sigBob1')
  pull(bob.id, 'Pda3', 2, '10000000', 'sigBob2')
  return { db, store }
}

test('the feed: committed per week, backers, buys and volume, with own wallets kept out of the third-party figures', () => {
  const { db } = seed()
  const [p] = feedFromDb(db, new Set([OWN]))
  assert.ok(p)
  assert.equal(p.pool, POOL)
  assert.equal(p.symbol, 'PROOF')
  assert.equal(p.quoteSymbol, 'SKR')
  // 50/h = 8,400 a week; 25 a week; 10 a day = 70 a week.
  assert.equal(p.committedPerWeek.all, '8495')
  assert.equal(p.committedPerWeek.thirdParty, '95')
  assert.deepEqual(p.backers, { all: 3, thirdParty: 2 })
  assert.deepEqual(p.buysExecuted, { all: 4, thirdParty: 3 })
  assert.deepEqual(p.volumeQuote, { all: '95', thirdParty: '45' })
  assert.equal(p.lastBuys.length, 4)
  assert.equal(p.lastBuys.filter((b) => b.own).length, 1)
  assert.equal(p.launchedOnNuntius, false)
  // The builder's share is the rest, exact in base units, and the sentence names it.
  assert.equal(p.committedPerWeek.builder, '8400')
  assert.deepEqual(p.commitment, {
    card: '2 backers commit 95 SKR a week to PROOF, plus 8400 SKR a week from the builder.',
    line: '2 backers commit 95 SKR a week, plus 8400 SKR a week from the builder',
  })
})

test('the commitment sentence says whose money it is: only the builder, mixed, outside only, none', () => {
  const s = (all: number, thirdParty: number, outside: string, builder: string) =>
    commitmentSentence({
      symbol: 'NIMUS',
      quoteSymbol: 'SKR',
      committedPerWeek: { thirdParty: outside, builder },
      backers: { all, thirdParty },
    })
  // nimus on 6 Oct: cj7 at 5 SKR a day and natX at 1 SKR a day, both the builder's own wallets.
  assert.deepEqual(s(2, 0, '0', '42'), {
    card: 'The builder backs NIMUS with 42 SKR a week. No outside backers yet.',
    line: '42 SKR a week, all the builder’s own',
  })
  assert.deepEqual(s(5, 3, '60', '42'), {
    card: '3 backers commit 60 SKR a week to NIMUS, plus 42 SKR a week from the builder.',
    line: '3 backers commit 60 SKR a week, plus 42 SKR a week from the builder',
  })
  assert.deepEqual(s(1, 1, '7', '0'), {
    card: '1 backer commits 7 SKR a week to NIMUS.',
    line: '1 backer commits 7 SKR a week',
  })
  assert.deepEqual(s(0, 0, '0', '0'), { card: 'No backers yet.', line: 'No backers yet.' })
})

test('a revoked backer leaves the committed demand but keeps its buys', () => {
  const { db, store } = seed()
  const bob = store.getMandateByPda('Pda3')!
  store.setStatus(bob.id, 'revoked', 3_000)
  const [p] = feedFromDb(db, new Set([OWN]))
  assert.equal(p!.committedPerWeek.thirdParty, '25')
  assert.equal(p!.backers.thirdParty, 1)
  assert.equal(p!.buysExecuted.thirdParty, 3)
})

test('GET /api/launches and the stream: a buy and one migration event per pool', async () => {
  const { db } = seed()
  const own = new Set([OWN])
  const bus = new FeedBus(db, own)
  const app = express()
  registerFeedRoutes(app, {
    db,
    own,
    bus,
    chain: async () => ({
      route: 'dbc',
      dammPool: null,
      progressPct: 12.5,
      quoteRaised: '12500000',
      threshold: '100000000',
    }),
    limiter: new RateLimiter(100, 60_000),
    heartbeatMs: 60_000,
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const j = (await (await fetch(`${base}/api/launches`)).json()) as {
      ok: boolean
      launches: { chain: { progressPct: number }; committedPerWeek: { thirdParty: string } }[]
    }
    assert.equal(j.ok, true)
    assert.equal(j.launches[0]!.chain.progressPct, 12.5)
    assert.equal(j.launches[0]!.committedPerWeek.thirdParty, '95')

    const ac = new AbortController()
    const res = await fetch(`${base}/api/launches/stream`, { signal: ac.signal })
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = res.body!.getReader()
    const read = async () => new TextDecoder().decode((await reader.read()).value)
    assert.match(await read(), /event: hello/)
    const ev = (kind: 'buy' | 'migrated', pda: string, sig: string) => ({
      kind,
      at: 5_000,
      delegationPda: pda,
      delegatee: 'Executor',
      label: null,
      amountBaseUnits: kind === 'buy' ? '25000000' : null,
      decimals: 6,
      symbol: 'SKR',
      signature: kind === 'buy' ? sig : `migrated:${POOL}:${pda}`,
      actor: 'nuntius' as const,
      outBaseUnits: kind === 'buy' ? '123' : null,
      outSymbol: 'PROOF',
      note: kind === 'migrated' ? sig : null,
    })
    bus.fromReceipt(ANA, ev('buy', 'Pda2', 'sigAna2'))
    const buy = JSON.parse(/data: (.*)\n/.exec(await read())![1]!) as FeedEvent
    assert.deepEqual(
      { kind: buy.kind, pool: buy.pool, signature: buy.signature, quoteIn: buy.quoteIn, own: buy.own },
      { kind: 'buy', pool: POOL, signature: 'sigAna2', quoteIn: '25', own: false },
    )
    // Every backer gets a migration receipt; the stream says it once.
    bus.fromReceipt(ANA, ev('migrated', 'Pda2', 'migSig'))
    bus.fromReceipt(BOB, ev('migrated', 'Pda3', 'migSig'))
    bus.fromReceipt(OWN, ev('buy', 'Pda1', 'sigOwn2'))
    let rest = ''
    while (!rest.includes('sigOwn2')) rest += await read()
    assert.equal(rest.match(/event: migrated/g)?.length, 1)
    assert.match(rest, /"signature":"migSig"/)
    ac.abort()
  } finally {
    server.close()
  }
})

test('streams are capped per IP', async () => {
  const { db } = seed()
  const own = new Set([OWN])
  const app = express()
  registerFeedRoutes(app, {
    db,
    own,
    bus: new FeedBus(db, own),
    chain: async () => null,
    limiter: new RateLimiter(100, 60_000),
    maxStreamsPerIp: 1,
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const ac = new AbortController()
  try {
    const first = await fetch(`${base}/api/launches/stream`, { signal: ac.signal })
    assert.equal(first.status, 200)
    assert.equal((await fetch(`${base}/api/launches/stream`)).status, 429)
  } finally {
    ac.abort()
    server.close()
  }
})

test("the next buys: each live backing once, at the executor's own jitter, soonest first; buys carry their backer", () => {
  const { db, store } = seed()
  // Ana's weekly backing was active from 1,000 ms; her pull for the period starting at 1 s landed.
  const now = 700_000 * 1000
  const [p] = feedFromDb(db, new Set([OWN]), now)
  assert.ok(p)
  const ana = store.getMandateByPda('Pda2')!
  // Her last claimed period started at 1 s; at 700,000 s the current period starts at 604,801 s,
  // which she has not claimed: that one is next, at buyJitterS past its start.
  const want = (604_801 + buyJitterS(ana.id, 604_801, 604_800)) * 1000
  const hers = p.nextBuys.find((n) => n.backer === ANA)
  assert.deepEqual(hers, { at: want, quoteIn: '25', own: false, backer: ANA })
  assert.ok(
    p.nextBuys.every((n, i, a) => i === 0 || a[i - 1]!.at <= n.at),
    'soonest first',
  )
  assert.equal(new Set(p.nextBuys.map((n) => n.backer)).size, p.nextBuys.length, 'one per backing')
  assert.ok(p.lastBuys.every((b) => [OWN, ANA, BOB].includes(b.backer)))
  // A revoked backing is not scheduled.
  store.setStatus(ana.id, 'revoked', 3_000)
  const [q] = feedFromDb(db, new Set([OWN]), now)
  assert.equal(
    q!.nextBuys.some((n) => n.backer === ANA),
    false,
  )
})
