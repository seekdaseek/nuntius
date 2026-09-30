import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanLabel, describeMandate, formatUnits, parseUnits, periodWords } from './mandate-text.js'
import { canCreateMandate, LIMITS, tierOf } from './tier.js'
import { createLogger, redact, safeError } from './log.js'
import { buildDigest, computeStreak, digestDue, localDay, type LedgerEvent } from './digest.js'
import { effectiveWindow } from './mandate-chain.js'

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
  assert.equal(d.title, '1 pull refused by the chain overnight')
  assert.equal(d.totals.pulls, 2)
  assert.equal(d.totals.moved.USDC, '7.4')
  assert.deepEqual(d.expiringSoon, ['Rent'])
  assert.ok(d.lines.includes('Rent: 7.5 of 10 USDC left this period.'))
  assert.match(d.body, /Tap to clock in/)

  const quiet = buildDigest([], [], now)
  assert.equal(quiet.title, 'Quiet night, nothing moved')
  assert.match(quiet.body, /^No live permissions\./)
  const pulled = buildDigest(
    [ev({ amountBaseUnits: '50000' }), ev({ amountBaseUnits: '25000000', symbol: 'SKR', label: 'Club' })],
    [],
    now,
  )
  assert.equal(pulled.title, '2 pulls overnight: 0.05 USDC and 25 SKR moved')
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
  assert.deepEqual(p.data, { url: pulled.url, channelId: 'alerts' })
  const body = fcmMessage('tok', p.notification, p.channelId, p.data, p.tag)
  assert.deepEqual(body.message.android, {
    priority: 'HIGH',
    notification: { channel_id: 'alerts', tag: `permission:${ev.delegationPda}` },
  })
  assert.equal(body.message.data.url, pulled.url, 'the tap target rides in data for every app state')
  const digest = fcmParts({
    title: 'Quiet night, nothing moved',
    body: 'x',
    url: '/digest?source=digest',
    channel: 'digest',
  })
  assert.equal(digest.channelId, 'digest', 'the digest goes to its own quiet channel')
  assert.equal(digest.tag, 'digest')
})
