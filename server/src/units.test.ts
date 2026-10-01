import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanLabel, describeMandate, formatUnits, parseUnits, periodWords } from './mandate-text.js'
import { canCreateMandate, LIMITS, tierOf } from './tier.js'
import { createLogger, redact, safeError } from './log.js'
import { buildDigest, computeStreak, digestDue, localDay, type LedgerEvent } from './digest.js'
import { effectiveWindow } from './mandate-chain.js'
import { freshNonce } from './mandates-api.js'
import { computeBudgetInstructions, PULL_BUDGET, priorityFeeLamports } from './tx.js'

test('parseUnits / formatUnits are exact inverses and refuse extra precision', () => {
  assert.equal(parseUnits('10', 6), 10_000_000n)
  assert.equal(parseUnits('0.01', 6), 10_000n)
  assert.equal(parseUnits('2.5', 6), 2_500_000n)
  assert.equal(parseUnits(' 7 ', 0), 7n)
  assert.throws(() => parseUnits('0.0000001', 6), /decimal places/)
  assert.throws(() => parseUnits('0', 6), /greater than zero/)
  assert.throws(() => parseUnits('-1', 6), /plain number/)
  assert.throws(() => parseUnits('1e3', 6), /plain number/)
  assert.throws(() => parseUnits('abc', 6))
  assert.equal(formatUnits(5_000n, 6), '0.005', 'the mainnet bug: 5,000 base units is not "0"')
  assert.equal(formatUnits(10_000_000n, 6), '10')
  assert.equal(formatUnits(17_000n, 6), '0.017')
  for (const s of ['1', '0.000001', '123.456789', '99999']) assert.equal(formatUnits(parseUnits(s, 6), 6), s)
})

test('periodWords never says "monthly" for a fixed 30-day period', () => {
  assert.equal(periodWords(2_592_000), 'every 30 days')
  assert.equal(periodWords(604_800), 'every week')
  assert.equal(periodWords(60), 'every minute')
  assert.equal(periodWords(90), 'every 90 seconds')
  assert.equal(periodWords(172_800), 'every 2 days')
  assert.equal(periodWords(7_200), 'every 2 hours')
})

test('describeMandate states the cap, who enforces it, and the exit', () => {
  const d = describeMandate({
    label: 'Rent to Ana',
    payee: 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX',
    amountBaseUnits: 10_000_000n,
    decimals: 6,
    symbol: 'USDC',
    periodLengthS: 604_800,
    expiryTs: Date.UTC(2026, 11, 31) / 1000,
  })
  assert.equal(d.headline, 'Rent to Ana (ASCQ…natX) can receive up to 10 USDC every week, until 31 Dec 2026.')
  assert.equal(d.schedule, 'nuntius sends the first 10 USDC right after you approve, then one payment every week.')
  assert.match(d.guarantee, /refused by the Solana program itself/)
  assert.equal(
    d.enforce,
    'The chain will enforce this: at most 10 USDC a week to ASCQ…natX, until 31 Dec. A pull above that fails with error 0x190.',
  )
  assert.match(d.exit, /one approval/)
})

test('cleanLabel accepts short human labels and rejects markup', () => {
  assert.equal(cleanLabel('  Rent   to Ana '), 'Rent to Ana')
  assert.equal(cleanLabel(undefined), '')
  assert.throws(() => cleanLabel('<script>'))
  assert.throws(() => cleanLabel('x'.repeat(41)))
  assert.throws(() => cleanLabel(5))
})

test('tier gate: guard is free, mandates scale with Seeker verification', () => {
  assert.equal(tierOf({ sgtMint: null }), 'basic')
  assert.equal(tierOf({ sgtMint: 'Gv9AN58bVkqWp4w7dNc7nT3cJAavAH1VBi4fpESsCVZn' }), 'seeker')
  assert.equal(LIMITS.basic.guard, true)
  assert.deepEqual(canCreateMandate('basic', 0), { ok: true })
  const r = canCreateMandate('basic', 1)
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.error, 'tier_limit')
  assert.deepEqual(canCreateMandate('seeker', 9), { ok: true })
  assert.equal(canCreateMandate('seeker', 10).ok, false)
  assert.equal(LIMITS.basic.dailyDigest, false)
  assert.equal(LIMITS.seeker.dailyDigest, true)
})

test('redact removes API keys, bearer tokens, keypairs, push and session tokens; keeps chain data', () => {
  const sig = '5r7YnGrbRCPb74W1t1p1xDzMtaTPL47orLsbGmpiMgAkmwbEfU9MKW7hGpZP4mcwv1cFLAXTq8pGWNsFUGinugMw'
  const addr = 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX'
  const keypair = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7) % 256))
  const push = 'cX1a2b3c4d5e:' + 'A'.repeat(140)
  const line = [
    'rpc https://mainnet.helius-rpc.com/?api-key=0123-secret-4567 failed',
    'Authorization: Bearer abc.def.ghi',
    `key ${keypair}`,
    `token ${push}`,
    '{"session":"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg"}',
    `sig ${sig} addr ${addr}`,
  ].join('\n')
  const out = redact(line)
  assert.doesNotMatch(out, /0123-secret-4567/)
  assert.doesNotMatch(out, /abc\.def\.ghi/)
  assert.match(out, /\[secret-key\]/)
  assert.match(out, /\[push-token\]/)
  assert.doesNotMatch(out, /AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg/)
  assert.match(out, new RegExp(sig), 'signatures survive: they are public evidence')
  assert.match(out, new RegExp(addr), 'addresses survive')

  const lines: string[] = []
  const log = createLogger((l) => lines.push(l))
  log.error('rpc_failed', { url: 'https://x.io/?api-key=SECRET', amount: 5n })
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0]!, /SECRET/)
  assert.match(lines[0]!, /"amount":"5"/)
  assert.equal(safeError(new Error('fetch https://h/?api-key=K1 failed')), 'fetch https://h/?api-key=*** failed')
})

test('effectiveWindow mirrors the program: lazy roll by whole periods, expiry is a hard stop', () => {
  const s = {
    amountPerPeriod: 100n,
    amountPulledInPeriod: 60n,
    currentPeriodStartTs: 1_000n,
    periodLengthS: 60n,
    expiryTs: 0n,
  }
  assert.deepEqual(effectiveWindow(s, 1_030n), {
    periodStart: 1_000n,
    periodIndex: 0n,
    used: 60n,
    remaining: 40n,
    nextResetTs: 1_060n,
    expired: false,
  })
  // two and a half periods later: stored counter is stale, window is fresh
  const later = effectiveWindow(s, 1_150n)
  assert.equal(later.periodStart, 1_120n)
  assert.equal(later.remaining, 100n)
  assert.equal(later.periodIndex, 2n)
  assert.equal(effectiveWindow({ ...s, expiryTs: 1_100n }, 1_100n).expired, true)
  assert.equal(effectiveWindow({ ...s, expiryTs: 1_100n }, 1_100n).remaining, 0n)
  assert.equal(effectiveWindow(s, 999n).remaining, 0n, 'not started')
})

const ev = (p: Partial<LedgerEvent>): LedgerEvent => ({
  kind: 'pull',
  at: Date.UTC(2026, 9, 1, 3),
  delegationPda: 'P',
  delegatee: 'DeLegatee111111111111111111111111111111111',
  label: 'Rent',
  amountBaseUnits: '1000000',
  decimals: 6,
  symbol: 'USDC',
  signature: 's',
  actor: 'nuntius',
  ...p,
})

test('digest leads with refusals, sums exactly, and lists caps left', () => {
  const now = Date.UTC(2026, 9, 1, 8)
  const d = buildDigest(
    [
      ev({ amountBaseUnits: '2500000' }),
      ev({ amountBaseUnits: '4900000', label: 'Gym' }),
      ev({ kind: 'refused', label: 'Gym', amountBaseUnits: null }),
      ev({ at: Date.UTC(2026, 8, 29), amountBaseUnits: '99000000' }), // older than 24h: ignored
    ],
    [
      {
        delegationPda: 'P',
        label: 'Rent',
        delegatee: 'D',
        remainingBaseUnits: '7500000',
        capBaseUnits: '10000000',
        decimals: 6,
        symbol: 'USDC',
        nextResetTs: now / 1000 + 3600,
        expiryTs: now / 1000 + 3 * 86_400,
      },
    ],
    now,
  )
  assert.equal(d.title, '1 pull refused by the chain in the last 24 hours')
  assert.equal(d.totals.pulls, 2)
  assert.equal(d.totals.moved.USDC, '7.4')
  assert.deepEqual(d.expiringSoon, ['Rent'])
  assert.ok(d.lines.includes('Rent: 7.5 of 10 USDC left this period.'))
  assert.match(d.body, /Tap to clock in/)

  const quiet = buildDigest([], [], now)
  assert.equal(quiet.title, 'Nothing moved in the last 24 hours')
  assert.match(quiet.body, /^No live permissions\./)
  const pulled = buildDigest(
    [ev({ amountBaseUnits: '50000' }), ev({ amountBaseUnits: '25000000', symbol: 'SKR', label: 'Club' })],
    [],
    now,
  )
  assert.equal(pulled.title, '2 pulls in the last 24 hours: 0.05 USDC and 25 SKR moved')
  // Since the previous digest: a refusal from before it is not counted again.
  const sinceLast = buildDigest(
    [ev({ kind: 'refused', at: now - 29 * 3_600_000 }), ev({ kind: 'refused', at: now - 3_600_000 })],
    [],
    now,
    now - 24 * 3_600_000,
  )
  assert.equal(sinceLast.title, '1 pull refused by the chain since your last digest')
  assert.equal(sinceLast.totals.refused, 1)
  const foreign = buildDigest([ev({ kind: 'granted', actor: 'other', label: null })], [], now)
  assert.equal(foreign.title, 'A new permission appeared on your wallet')
  assert.match(foreign.lines[0]!, /granted outside nuntius/)
  for (const s of [d, quiet, pulled, foreign]) {
    assert.doesNotMatch(`${s.title} ${s.body} ${s.lines.join(' ')}`, /·|mandate/i, 'user-facing copy')
  }
})

test('streak counts consecutive days, survives until the user has had today to clock in', () => {
  assert.deepEqual(computeStreak(['2026-10-01', '2026-10-02', '2026-10-03'], '2026-10-03'), {
    current: 3,
    clockedInToday: true,
    best: 3,
  })
  assert.equal(computeStreak(['2026-10-01', '2026-10-02'], '2026-10-03').current, 2, 'not broken yet today')
  assert.equal(computeStreak(['2026-10-01'], '2026-10-03').current, 0, 'a missed day breaks it')
  assert.equal(computeStreak(['2026-09-01', '2026-09-02', '2026-09-03', '2026-10-03'], '2026-10-03').best, 3)
  assert.equal(computeStreak(['2026-02-28', '2026-03-01'], '2026-03-01').current, 2, 'month boundary')
  assert.equal(localDay(Date.UTC(2026, 9, 1, 22), 180), '2026-10-02', 'EEST is already tomorrow')
})

test('digestDue fires once per local day at or after the chosen hour', () => {
  const at = (h: number) => Date.UTC(2026, 9, 1, h) // UTC hours
  const pref = { hour: 8, tzOffsetMin: 180, lastSentDay: null as string | null }
  assert.equal(digestDue(at(4), pref), false, '07:00 EEST')
  assert.equal(digestDue(at(5), pref), true, '08:00 EEST')
  assert.equal(digestDue(at(5), { ...pref, lastSentDay: '2026-10-01' }), false, 'already sent today')
  assert.equal(digestDue(at(22), { ...pref, lastSentDay: '2026-10-01' }), false, '01:00 next local day is before 08:00')
  assert.equal(digestDue(at(29), { ...pref, lastSentDay: '2026-10-01' }), true, '08:00 next local day')
  assert.equal(
    digestDue(at(10), { ...pref, savedAtMs: at(9) }),
    false,
    'chosen at 12:00 EEST: 08:00 today is not overdue',
  )
  assert.equal(digestDue(at(29), { ...pref, savedAtMs: at(9) }), true, 'it starts tomorrow at 08:00')
})

test('sessions expire 30 days after sign-in', async () => {
  const { openDb, Store, SESSION_TTL_MS } = await import('./db.js')
  const store = new Store(openDb(':memory:'))
  const t0 = Date.UTC(2026, 8, 1)
  store.createSession('T'.repeat(43), 'Addr', t0)
  assert.ok(store.getSession('T'.repeat(43), t0 + SESSION_TTL_MS - 1))
  assert.equal(store.getSession('T'.repeat(43), t0 + SESSION_TTL_MS), null)
})

test('MANDATE_MINTS: optional per-mint ceiling; mainnet offers USDC and SKR by default', async () => {
  const { loadMandateConfig, parseMints, SKR_MAINNET } = await import('./mandate-config.js')
  const A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const S = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'
  assert.deepEqual(parseMints(`USDC:${A}:6:1,SKR:${S}:6:250`), [
    { symbol: 'USDC', mint: A, decimals: 6, maxPerPeriodUi: '1' },
    { symbol: 'SKR', mint: S, decimals: 6, maxPerPeriodUi: '250' },
  ])
  assert.deepEqual(parseMints(`USDC:${A}:6`), [{ symbol: 'USDC', mint: A, decimals: 6 }])
  assert.throws(() => parseMints(`USDC:${A}:6:lots`), /bad ceiling/)
  assert.throws(() => parseMints(`USDC:${A}:6:1:9`), /too many fields/)
  const cfg = loadMandateConfig({ MANDATE_CLUSTER: 'mainnet' }, 'https://rpc.example/?api-key=x')!
  assert.deepEqual(
    cfg.mints.map((m) => m.symbol),
    ['USDC', 'SKR'],
  )
  assert.equal(cfg.mints[1]!.mint, S)
  assert.equal(SKR_MAINNET.maxPerPeriodUi, '55', 'about 1 USD of SKR')
  assert.equal(SKR_MAINNET.decimals, 6)
})

test('allowance: lifetime totals follow the program period rules', async () => {
  const { recurringLifetime, newGrantLifetime, allowanceFor } = await import('./allowance.js')
  const d = (o: Partial<Parameters<typeof recurringLifetime>[0]> = {}) => ({
    amountPerPeriod: 100n,
    amountPulledInPeriod: 0n,
    currentPeriodStartTs: 1000n,
    periodLengthS: 10n,
    expiryTs: 1035n, // billable starts 1000, 1010, 1020, 1030
    ...o,
  })
  assert.equal(recurringLifetime(d(), 1000n), 400n)
  assert.equal(recurringLifetime(d({ amountPulledInPeriod: 30n }), 1005n), 370n, 'pulled counts in its own period')
  assert.equal(recurringLifetime(d({ amountPulledInPeriod: 30n }), 1012n), 300n, 'a rolled period drops the old pulled')
  assert.equal(recurringLifetime(d(), 1034n), 100n, 'the last billable period')
  assert.equal(recurringLifetime(d(), 1035n), 100n, 'at expiry the last period still bills (current_ts > expiry fails)')
  assert.equal(recurringLifetime(d(), 1036n), 0n)
  assert.equal(recurringLifetime(d({ expiryTs: 1030n }), 1000n), 300n, 'a start exactly at expiry is not billable')
  assert.equal(recurringLifetime(d({ expiryTs: 0n }), 1000n), null, 'no expiry: unbounded')
  assert.equal(recurringLifetime(d(), 900n), 400n, 'not started yet')
  assert.equal(newGrantLifetime(50_000n, 86_400n, 0n, 7n * 86_400n, 0n), 350_000n, '0.05 a day for 7 days')
  assert.equal(newGrantLifetime(1n, 10n, 0n, 0n, 0n), null)
  const view = (o: Record<string, unknown>) =>
    ({
      address: 'A',
      kind: 'recurring',
      delegator: 'U',
      delegatee: 'X',
      mint: 'M',
      amountPerPeriod: '100',
      amountPulledInPeriod: '0',
      currentPeriodStartTs: 1000,
      periodLengthS: 10,
      expiryTs: 1035,
      amount: null,
      ...o,
    }) as never
  const list = [
    view({ address: 'A' }),
    view({ address: 'B', mint: 'OTHER' }),
    view({ address: 'F', kind: 'fixed', amount: '7' }),
  ]
  assert.equal(allowanceFor(list, 'M', 1000n, 5n), 412n, 'this mint only: 400 + fixed 7 + new 5')
  assert.equal(allowanceFor(list, 'M', 1000n, 0n, 'A'), 7n, 'excluding the one being revoked')
  assert.equal(
    allowanceFor([...list, view({ address: 'S', kind: 'subscription', mint: null })], 'M', 1000n),
    null,
    'a plan subscription: no cap',
  )
})

test('push: one tray tag per permission, the digest on its own channel, the url always in data', async () => {
  const { receiptMessage, fcmParts } = await import('./receipts.js')
  const { fcmMessage } = await import('./fcm.js')
  const ev = {
    kind: 'pull',
    at: Date.UTC(2026, 8, 30, 15, 31),
    delegationPda: 'Pda1111111111111111111111111111111111111111',
    delegatee: 'DeLegatee111111111111111111111111111111111',
    label: 'natXcheck',
    amountBaseUnits: '50000',
    decimals: 6,
    symbol: 'USDC',
    signature: 'sig',
    actor: 'nuntius',
  } as const
  const pulled = receiptMessage(ev as never, { cluster: 'mainnet', remainingBaseUnits: 0n, capBaseUnits: 50000n })
  const refused = receiptMessage({ ...ev, kind: 'refused', amountBaseUnits: '1' } as never, { cluster: 'mainnet' })
  const granted = receiptMessage({ ...ev, kind: 'granted' } as never, { cluster: 'mainnet' })
  assert.equal(pulled.tag, `permission:${ev.delegationPda}`)
  assert.equal(refused.tag, pulled.tag, 'every push about one permission shares its tag')
  assert.equal(granted.tag, pulled.tag, '"Permission live" is replaced by the first "received"')
  for (const m of [pulled, refused, granted]) assert.match(m.url, /^\/alert\?/)
  const p = fcmParts(pulled)
  assert.deepEqual(p.data, { url: pulled.url, channelId: 'alerts', tag: pulled.tag })
  // With the app open, expo-notifications takes the notification's id from
  // data.tag: "received" must replace "Permission live" there as well.
  assert.equal(fcmParts(granted).data.tag, p.data.tag)
  const body = fcmMessage('tok', p.notification, p.channelId, p.data, p.tag)
  assert.deepEqual(body.message.android, {
    priority: 'HIGH',
    notification: { channel_id: 'alerts', tag: `permission:${ev.delegationPda}` },
  })
  assert.equal(body.message.data.url, pulled.url, 'the tap target rides in data for every app state')
  const digest = fcmParts({
    title: 'Nothing moved in the last 24 hours',
    body: 'x',
    url: '/digest?source=digest',
    channel: 'digest',
  })
  assert.equal(digest.channelId, 'digest', 'the digest goes to its own quiet channel')
  assert.equal(digest.tag, 'digest')
  assert.equal(digest.data.tag, 'digest')
})

test('receipts record the window after the pull; old databases gain the columns in place', async () => {
  const Database = (await import('better-sqlite3')).default
  const { MandateStore } = await import('./mandate-store.js')
  const { Receipts } = await import('./receipts.js')
  const db = new Database(':memory:')
  // A database created before the window columns existed, as on the deployed server.
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, kind TEXT NOT NULL,
    at INTEGER NOT NULL, delegation_pda TEXT NOT NULL, delegatee TEXT NOT NULL, label TEXT, amount TEXT,
    decimals INTEGER NOT NULL, symbol TEXT NOT NULL, signature TEXT, actor TEXT NOT NULL, pushed INTEGER NOT NULL DEFAULT 0)`)
  db.prepare(
    `INSERT INTO events (address, kind, at, delegation_pda, delegatee, amount, decimals, symbol, signature, actor)
     VALUES ('U', 'pull', 1, 'P', 'D', '10', 6, 'USDC', 'old', 'nuntius')`,
  ).run()
  const store = new MandateStore(db)
  const receipts = new Receipts(
    store,
    null,
    createLogger(() => {}),
    'mainnet',
  )
  await receipts.emit(
    'U',
    {
      kind: 'pull',
      at: 2,
      delegationPda: 'P',
      delegatee: 'D',
      label: 'natXcheck',
      amountBaseUnits: '50000',
      decimals: 6,
      symbol: 'USDC',
      signature: 'new',
      actor: 'nuntius',
    },
    { remainingBaseUnits: 0n, capBaseUnits: 50000n, nextResetTs: 1_790_000_000, periodLengthS: 86_400 },
  )
  const [newest, oldest] = store.events('U')
  assert.equal(newest!.remainingBaseUnits, '0')
  assert.equal(newest!.capBaseUnits, '50000')
  assert.equal(newest!.nextResetTs, 1_790_000_000)
  assert.equal(newest!.periodLengthS, 86_400)
  assert.equal(oldest!.signature, 'old', 'existing receipts survive the migration')
  assert.equal(oldest!.remainingBaseUnits, undefined, 'and have no window')
})

test('grant seeds are random, never a counter that restarts with the database', () => {
  const seen = new Set<number>()
  for (let i = 0; i < 2000; i++) {
    const n = freshNonce()
    assert.ok(Number.isSafeInteger(n) && n >= 0 && n < 2 ** 48)
    seen.add(n)
  }
  assert.equal(seen.size, 2000, 'no repeats')
  assert.ok(
    [...seen].every((n) => n > 1_000),
    'not the 0, 1, 2… a counter hands out',
  )
})

test('pull compute budget: unit limit and price, as the Compute Budget program reads them', () => {
  const [limit, price] = computeBudgetInstructions({ unitLimit: 40_000, microLamportsPerUnit: 50_000 })
  assert.equal(limit!.programAddress, 'ComputeBudget111111111111111111111111111111')
  assert.deepEqual([...limit!.data!], [2, 0x40, 0x9c, 0, 0]) // 40,000 LE
  assert.deepEqual([...price!.data!], [3, 0x50, 0xc3, 0, 0, 0, 0, 0, 0]) // 50,000 LE
  assert.equal(priorityFeeLamports(PULL_BUDGET), 2_000n, '0.000002 SOL a pull')
})

test('receipt feed: a new permission shows only its own receipts; ended ones are dated sections', async () => {
  const { receiptFeed } = await import('./receipt-feed.js')
  const day = 86_400_000
  const t0 = Date.UTC(2026, 8, 22)
  const ev = (id: number, kind: string, at: number, mandateId: string | null, pda = 'PdaA', label = 'cj7check') =>
    ({
      id,
      kind,
      at,
      mandateId,
      delegationPda: pda,
      delegatee: 'Dlg1111111111111111111111111111111111111111',
      label,
      amountBaseUnits: kind === 'pull' ? '10000' : null,
      decimals: 6,
      symbol: 'USDC',
      signature: `s${id}`,
      actor: mandateId ? 'nuntius' : 'other',
    }) as unknown as import('./receipt-feed.js').FeedEvent
  const mandates = [
    { id: 'old', label: 'cj7check', symbol: 'USDC', status: 'revoked', createdAt: t0, endedAt: t0 + 8 * day },
    { id: 'new', label: 'cj7check', symbol: 'USDC', status: 'active', createdAt: t0 + 9 * day, endedAt: null },
  ] as const
  const events = [
    ev(1, 'pull', t0 + 1000, 'old'),
    ev(2, 'refused', t0 + 2000, 'old'),
    ev(3, 'revoked', t0 + 8 * day, 'old'),
    ev(4, 'granted', t0 + 9 * day, 'new', 'PdaB'),
    ev(5, 'pull', t0 + 9 * day + 10_000, 'new', 'PdaB'),
    // Another app: one delegation that ended, then a new one at the same address.
    ev(6, 'pull', t0 + 3 * day, null, 'PdaX', null as never),
    ev(7, 'revoked', t0 + 4 * day, null, 'PdaX', null as never),
    ev(8, 'granted', t0 + 9 * day + 1, null, 'PdaX', null as never),
  ]
  const f = receiptFeed(events, [...mandates] as never, new Set(['PdaX']))
  assert.deepEqual(
    f.live.map((e) => e.id),
    [5, 8, 4],
    'live: the new permission since its grant, and the other app’s current one',
  )
  assert.deepEqual(
    f.ended.map((s) => [s.label, s.receipts.map((e) => e.id)]),
    [
      ['cj7check', [3, 2, 1]],
      ['Dlg1…1111', [7, 6]],
    ],
    'ended: newest first, each with its own receipts',
  )
  assert.equal(f.ended[0]!.from, t0 + 1000)
  assert.equal(f.ended[0]!.to, t0 + 8 * day)
})

test('receipts belong to a mandate; one from before the mandate at its address is never recorded or kept', async () => {
  const Database = (await import('better-sqlite3')).default
  const { MandateStore } = await import('./mandate-store.js')
  const grantAt = Date.UTC(2026, 8, 30, 15, 20)
  const base = {
    address: 'Natx',
    label: 'cj7check',
    payee: 'P',
    receiverAta: 'R',
    mint: 'M',
    symbol: 'USDC',
    decimals: 6,
    amountPerPeriod: '10000',
    pullAmount: '10000',
    periodLengthS: 86400,
    expiryTs: 0,
    nonce: 1,
    delegatee: 'D',
    delegationPda: '32KCvaok',
    authorityPda: 'A',
    userAta: 'U',
  }
  const e = (sig: string, kind: string, at: number) =>
    ({
      kind,
      at,
      delegationPda: '32KCvaok',
      delegatee: 'D',
      label: 'cj7check',
      amountBaseUnits: '10000',
      decimals: 6,
      symbol: 'USDC',
      signature: sig,
      actor: 'other',
    }) as never
  // A database from before: receipts without a mandate, six of them from 22 Sep at
  // the address a 30 Sep permission now holds (the old guard's replay).
  const db = new Database(':memory:')
  new MandateStore(db).insertMandate(base, grantAt)
  db.exec('UPDATE events SET mandate_id = NULL')
  const insert = db.prepare(
    `INSERT INTO events (address, kind, at, delegation_pda, delegatee, label, amount, decimals, symbol, signature, actor)
     VALUES ('Natx', ?, ?, '32KCvaok', 'D', 'cj7check', '1', 6, 'USDC', ?, 'other')`,
  )
  for (let i = 0; i < 6; i++) insert.run(i < 4 ? 'pull' : 'refused', Date.UTC(2026, 8, 22, 12, i), `old${i}`)
  insert.run('pull', grantAt + 22_000, 'new1')
  insert.run('pull', Date.UTC(2026, 8, 20), 'foreign-elsewhere')
  db.exec("UPDATE events SET delegation_pda = 'OtherPda' WHERE signature = 'foreign-elsewhere'")
  // Restart: the migration attributes and cleans.
  const store = new MandateStore(db)
  const left = store.events('Natx').map((x) => [x.signature, x.mandateId !== null])
  assert.deepEqual(left, [
    ['new1', true],
    ['foreign-elsewhere', false],
  ])
  // And the gate holds for new receipts: before the mandate at that address, refused.
  assert.equal(store.addEvent('Natx', e('old9', 'pull', Date.UTC(2026, 8, 22))), null)
  assert.notEqual(store.addEvent('Natx', e('new2', 'pull', grantAt + 3_600_000)), null)
})
