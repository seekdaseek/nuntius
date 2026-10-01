// Run: npm run test:core   (node --test with native type stripping; no bundler, no Android)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, count, explorerTx, remainingShare, resetsIn, shortAddr, tzOffsetMin } from './format.ts'
import { widgetView, type WidgetSnapshot } from './widget-model.ts'
import {
  basicTierLine,
  digestPicker,
  endedHeader,
  initial,
  lineTone,
  longDate,
  meter,
  nextMovement,
  perWords,
  span,
  summaryLine,
  untilWords,
  weekSlots,
  whenWords,
  windowWords,
} from './home-model.ts'
import {
  applyStarter,
  checkForm,
  isStarter,
  PERIOD_OPTIONS,
  sanitizeAmount,
  SKR_STARTERS,
  startersFor,
} from './mandate-form.ts'
import { isBlockhashExpired } from './grant-errors.ts'
import { revokeFailureText, walletFailureText, WalletStepError, withStoredAuthorization } from './wallet-session.ts'

const NOW = Date.UTC(2026, 9, 1, 12)
const nowS = NOW / 1000

test('resetsIn counts down without a timezone', () => {
  assert.equal(resetsIn(nowS + 3 * 3600 + 12 * 60, NOW), 'resets in 3h 12m')
  assert.equal(resetsIn(nowS + 2 * 86_400 + 3600, NOW), 'resets in 2d 1h')
  assert.equal(resetsIn(nowS + 45, NOW), 'resets in 45s')
  assert.equal(resetsIn(nowS - 1, NOW), 'resets now')
  assert.equal(resetsIn(null, NOW), 'reset time unknown')
})

test('formatting helpers', () => {
  assert.equal(shortAddr('ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX'), 'ASCQ…natX')
  assert.equal(remainingShare('2.5', '10'), 0.25)
  assert.equal(remainingShare('12', '10'), 1)
  assert.equal(remainingShare(null, '10'), 0)
  assert.equal(remainingShare('1', '0'), 0)
  assert.equal(ago(NOW - 5 * 60_000, NOW), '5m ago')
  assert.equal(ago(NOW - 3 * 86_400_000, NOW), '3d ago')
  assert.equal(explorerTx('abc', 'mainnet'), 'https://explorer.solana.com/tx/abc')
  assert.equal(explorerTx('abc', 'devnet'), 'https://explorer.solana.com/tx/abc?cluster=devnet')
  assert.equal(explorerTx('abc', 'localnet'), null, 'no link to a chain nobody else can see')
  assert.equal(typeof tzOffsetMin(), 'number')
})

const snap = (p: Partial<WidgetSnapshot> = {}): WidgetSnapshot => ({
  rows: [{ label: 'Rent', remaining: '2.5', cap: '10', symbol: 'USDC', nextResetTs: nowS + 5400 }],
  liveCount: 1,
  lastReceipt: { kind: 'pull', at: NOW - 60_000, label: 'Rent', amount: '7.5', symbol: 'USDC' },
  streak: 4,
  clockedInToday: false,
  fetchedAt: NOW - 60_000,
  ...p,
})

test('widget: signed out, not loaded, live, stale; no middle dots anywhere', () => {
  assert.equal(widgetView(null, false, NOW).footer, 'Sign in to see your permissions')
  assert.equal(widgetView(null, true, NOW).footer, 'Open nuntius to load')
  const v = widgetView(snap(), true, NOW)
  assert.equal(v.title, 'nuntius')
  assert.equal(v.badge, 'Clock in, day 5')
  assert.deepEqual(v.rows, [{ left: 'Rent', right: '2.5 of 10 USDC', takenShare: 0.75 }])
  assert.equal(v.footer, '')
  assert.equal(v.url, '/digest', 'tap goes to clock-in when not done today')
  const done = widgetView(snap({ clockedInToday: true }), true, NOW)
  assert.equal(done.badge, 'Clocked in, day 4')
  assert.equal(done.url, '/')
  const s = widgetView(snap({ fetchedAt: NOW - 3 * 3_600_000 }), true, NOW)
  assert.equal(s.stale, true)
  assert.equal(s.footer, 'Not refreshed in 2 hours')
  for (const w of [v, done, s]) assert.doesNotMatch(JSON.stringify(w), /·/)
})

test('widget: a refusal is the footer, in the refused tone', () => {
  const v = widgetView(
    snap({ lastReceipt: { kind: 'refused', at: NOW, label: 'Gym', amount: null, symbol: 'USDC' } }),
    true,
    NOW,
  )
  assert.equal(v.footer, 'Refused by the chain: Gym')
  assert.equal(v.footerTone, 'refused')
})

test('widget: basic tier has no badge; extra permissions are counted', () => {
  const v = widgetView(snap({ streak: null, clockedInToday: null, liveCount: 3 }), true, NOW)
  assert.equal(v.badge, '')
  assert.equal(v.footer, '2 more in the app')
})

test('home model: meter, rate words, hero sentence, summary', () => {
  assert.deepEqual(meter('0.05', '0', 6), { takenShare: 1, taken: '0.05', left: '0' })
  assert.deepEqual(meter('0.01', '0.006', 6), { takenShare: 0.4, taken: '0.004', left: '0.006' })
  assert.deepEqual(meter('10', null, 6), { takenShare: 0, taken: '0', left: '10' })
  assert.equal(perWords(86_400), 'a day')
  assert.equal(perWords(3_600), 'an hour')
  assert.equal(perWords(2_592_000), 'every 30 days')
  assert.equal(windowWords(86_400), 'today')
  const live = [
    { label: 'Ana', cap: '0.05', remaining: '0', symbol: 'USDC', decimals: 6, nextResetTs: nowS + 6 * 3600 + 12 * 60 },
    { label: 'Gym', cap: '0.01', remaining: '0.006', symbol: 'USDC', decimals: 6, nextResetTs: nowS + 41 * 60 },
  ]
  assert.equal(nextMovement(live, NOW), 'Gym gets 0.01 USDC in 41m.')
  assert.equal(nextMovement([live[0]!], NOW), 'Ana gets 0.05 USDC in 6h 12m.')
  assert.equal(nextMovement([{ ...live[0]!, remaining: '0.05' }], NOW), 'Ana gets 0.05 USDC now.')
  assert.match(nextMovement([], NOW), /^Grant your first permission/)
  assert.equal(summaryLine(2, 0, 0), 'Two permissions live. Nothing refused today.')
  assert.equal(
    summaryLine(1, 1, 1),
    'One permission live. One held by other apps. One pull refused by the chain today.',
  )
  assert.equal(span(nowS + 90, NOW), '1m')
})

test('home model: punch slots, digest dots, dates', () => {
  const slots = weekSlots(['2026-09-26', '2026-09-27', '2026-09-29'], '2026-09-30')
  assert.deepEqual(
    slots.map((x) => `${x.label}:${x.state}`),
    ['Sat:punched', 'Sun:punched', 'Mon:missed', 'Tue:punched', 'Wed:today', 'Thu:future', 'Fri:future'],
  )
  assert.equal(weekSlots(['2026-09-30'], '2026-09-30')[4]!.state, 'todayPunched')
  assert.equal(lineTone('Refused by the chain: Gym asked above its cap.'), 'refused')
  assert.equal(lineTone('Rent received 1 USDC.'), 'moved')
  assert.equal(lineTone('New permission: X (granted outside nuntius — check it).'), 'foreign')
  assert.equal(lineTone('Rent: 1 of 2 USDC left this period.'), 'neutral')
  assert.equal(longDate(Date.UTC(2026, 8, 30, 9), 180), 'Wednesday 30 September')
  assert.equal(whenWords(Date.UTC(2026, 8, 29, 23), 180), '30 Sep at 02:00')
  assert.equal(untilWords(Date.UTC(2026, 8, 30, 9), 30, 180), '30 Oct')
  assert.equal(initial(' ana'), 'A')
})

test('mandate form checks', () => {
  const base = {
    label: 'Rent',
    payee: 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX',
    amount: '10',
    period: 'week' as const,
    untilDays: 90,
  }
  assert.deepEqual(checkForm(base, null), { ok: true, field: null, hint: null })
  assert.equal(checkForm({ ...base, payee: 'nope' }, null).field, 'payee')
  assert.equal(checkForm(base, base.payee).hint, 'That is your own wallet')
  assert.equal(checkForm({ ...base, amount: '0' }, null).field, 'amount')
  assert.equal(checkForm({ ...base, amount: '1.1234567' }, null).field, 'amount')
  assert.equal(checkForm({ ...base, label: 'x'.repeat(41) }, null).field, 'label')
  assert.equal(sanitizeAmount('1,50'), '1.50')
  assert.equal(sanitizeAmount('1.2.3'), '1.23')
  assert.equal(sanitizeAmount('$12a'), '12')
  assert.equal(sanitizeAmount('0.12345678'), '0.123456')
})

test('SKR starters: only when SKR is offered; they fill the sentence, never the payee', () => {
  assert.deepEqual(startersFor(['USDC']), [], 'no SKR, no starters')
  assert.deepEqual(startersFor([]), [])
  const s = startersFor(['USDC', 'SKR'])
  assert.deepEqual(
    s.map((x) => [x.starter.title, x.symbol, x.line]),
    [
      ['Back a Seeker builder', 'SKR', '25 SKR every week, for 90 days'],
      ['Allowance in SKR', 'SKR', '50 SKR every week, for 30 days'],
    ],
  )
  assert.equal(startersFor(['tUSDC', 'tSKR'])[0]!.symbol, 'tSKR', 'the localnet stand-in')
  for (const { starter } of s) {
    assert.ok(Number(starter.amount) <= 55, `${starter.key} fits the 55 SKR ceiling`)
    assert.doesNotMatch(`${starter.title} ${starter.label}`, /·|→|mandate/i)
  }

  const empty = { label: '', payee: '', amount: '', period: 'day' as const, untilDays: 30 }
  const builder = applyStarter(empty, SKR_STARTERS[0]!)
  assert.deepEqual(builder, { label: 'Seeker builder', payee: '', amount: '25', period: 'week', untilDays: 90 })
  assert.equal(checkForm(builder, null).field, 'payee', 'the payee is still to be entered')
  const payee = 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX'
  const allowance = applyStarter({ ...builder, payee }, SKR_STARTERS[1]!)
  assert.equal(allowance.payee, payee, 'a typed payee survives a starter tap')
  assert.deepEqual([allowance.amount, allowance.period, allowance.untilDays], ['50', 'week', 30])
  assert.ok(checkForm(allowance, null).ok)
  assert.ok(isStarter(allowance, 'SKR', 'SKR', SKR_STARTERS[1]!))
  assert.ok(!isStarter(allowance, 'SKR', 'USDC', SKR_STARTERS[1]!), 'token changed')
  assert.ok(!isStarter({ ...allowance, amount: '49' }, 'SKR', 'SKR', SKR_STARTERS[1]!), 'amount edited')
})

test('approve note: the token approval in plain words, with the exact total', async () => {
  const { approveNote, delegateLine } = await import('./allowance-copy.ts')
  const own = approveNote({ symbol: 'USDC', lifetimeTotal: '0.07', allowanceTotal: '0.07' })
  assert.match(own, /^This permission can take at most 0\.07 USDC in total\. Seed Vault will show 0\.07 USDC\./)
  // Two permissions share one allowance: both numbers, each where it belongs.
  const all = approveNote({ symbol: 'USDC', lifetimeTotal: '1.68', allowanceTotal: '1.98' })
  assert.match(
    all,
    /^This permission can take at most 1\.68 USDC in total\. Seed Vault will show 1\.98 USDC, because one approval covers all your live USDC permissions\./,
  )
  assert.doesNotMatch(all, /caps it at 1\.98/)
  assert.match(
    approveNote({ symbol: 'SKR', lifetimeTotal: '325', allowanceTotal: null }),
    /Seed Vault will show no limit, because another app's permission on SKR has no end date/,
  )
  assert.match(
    approveNote({ symbol: 'SKR', lifetimeTotal: '325', allowanceTotal: undefined }),
    /^This permission can take at most 325 SKR in total\. Seed Vault may also warn/,
  )
  for (const s of [own, all]) assert.doesNotMatch(s, /·|→|UNLIMITED/)
  const short = (a: string) => `${a.slice(0, 4)}…`
  assert.equal(delegateLine([{ symbol: 'USDC', delegate: null }], short), 'Token account delegate: none')
  assert.equal(
    delegateLine(
      [
        { symbol: 'USDC', delegate: 'LaV5xyz', allowance: '0.35' },
        { symbol: 'SKR', delegate: null },
      ],
      short,
    ),
    "USDC token account delegate: LaV5…, the Subscriptions program's authority, allowed 0.35 USDC in total",
  )
  assert.match(delegateLine([{ symbol: 'SKR', delegate: 'Abcdefg', allowance: null }], short), /with no cap$/)
})

test('push tap: the receipt url is found for every app state and push type', async () => {
  const { tapTarget, tapUrl } = await import('./notification-tap.ts')
  const received = '/alert?source=receipt&kind=pull&who=natXcheck&amount=0.05&symbol=USDC&remaining=0&cap=0.05'
  const refused = '/alert?source=receipt&kind=refused&who=natXcheck&amount=0.000001&symbol=USDC'
  const res = (id: string, data: Record<string, unknown> | null, remote?: Record<string, unknown>) => ({
    notification: {
      request: {
        identifier: id,
        content: { data },
        trigger: remote ? { type: 'push', remoteMessage: { data: remote } } : { type: 'push' },
      },
    },
  })
  // Open: expo shows it and hands over the FCM data as content.data.
  assert.deepEqual(tapTarget(res('a', { url: received, channelId: 'alerts' }), null), {
    id: 'a',
    key: `a|${received}`,
    url: received,
  })
  assert.deepEqual(tapTarget(res('b', { url: refused, channelId: 'alerts' }), null)?.url, refused)
  // Background and killed: the tray tap's extras (plus FCM's own keys) become content.data.
  const extras = { url: received, channelId: 'alerts', 'google.message_id': '0:1', from: '123' }
  assert.equal(tapUrl(res('c', extras)), received)
  // Only the raw remote message carries it.
  assert.equal(tapUrl(res('d', null, { url: refused })), refused)
  // The digest and the widget targets.
  assert.equal(tapUrl(res('e', { url: '/digest?source=digest' })), '/digest?source=digest')
  // Already routed, no url, or not an app screen: nothing to open.
  assert.equal(tapTarget(res('a', { url: received }), `a|${received}`), null)
  // One permission, one tray id: "received" after "Permission live" is a new tap.
  const tag = 'permission:Pda1'
  const live = '/alert?source=receipt&kind=granted&who=natXcheck'
  const first = tapTarget(res(tag, { url: live, tag }), null)!
  assert.equal(tapTarget(res(tag, { url: received, tag }), first.key)?.url, received)
  // The same tap delivered twice (cold start: last response and the event) routes once.
  assert.equal(tapTarget(res(tag, { url: live, tag }), first.key), null)
  assert.equal(tapTarget(res('f', {}), null), null)
  assert.equal(tapTarget(null, null), null)
  for (const bad of ['https://evil.example/x', '//evil.example', '/somewhere-else', 'alert']) {
    assert.equal(tapUrl(res('g', { url: bad })), null, bad)
  }
})

test('receipt slip meter: what the receipt recorded, in the mockup words', async () => {
  const { slipMeter } = await import('./home-model.ts')
  const now = Date.UTC(2026, 8, 30, 15, 32)
  const reset = Math.floor(now / 1000) + 23 * 3600 + 58 * 60
  const m = slipMeter({ cap: '0.05', remaining: '0', per: 86_400, reset }, now)!
  assert.equal(m.takenShare, 1, 'a full meter')
  assert.equal(m.left, '0 of 0.05 left today')
  assert.equal(m.right, 'resets in 23h 58m')
  assert.equal(
    slipMeter({ cap: '0.01', remaining: '0', per: 3600, reset: 1 }, now)!.right,
    undefined,
    'a past reset is not shown',
  )
  assert.equal(slipMeter({ cap: '25', remaining: '0', per: 604_800 }, now)!.left, '0 of 25 left this week')
  assert.equal(slipMeter({ cap: '0.05', remaining: null }, now), null, 'no record, no meter')
  assert.equal(slipMeter({ cap: null, remaining: '0' }, now), null)
})

test('grant: a blockhash that died in Seed Vault is told apart from a dismissal and a real failure', () => {
  assert.equal(isBlockhashExpired({ code: -4, message: 'x' }), true)
  assert.equal(isBlockhashExpired({ code: 'ERROR_NOT_SUBMITTED', message: '' }), true)
  assert.equal(isBlockhashExpired(new Error('Transaction simulation failed: Blockhash not found')), true)
  assert.equal(isBlockhashExpired(new Error('block height exceeded')), true)
  assert.equal(isBlockhashExpired(new Error('User declined the request')), false)
  assert.equal(isBlockhashExpired(new Error('insufficient funds for fee')), false)
  assert.equal(isBlockhashExpired(null), false)
})

test('copy: counts agree with their nouns, and a basic home says basic from the start', () => {
  assert.equal(count(1, 'day'), '1 day')
  assert.equal(count(0, 'day'), '0 days')
  assert.equal(count(7, 'day'), '7 days')
  assert.match(basicTierLine(false, 1), /^Basic tier: you can hold one permission\./)
  assert.match(basicTierLine(true, 1), /^Basic tier holds one permission\./)
})

test('period chips match the mockup: "month" is the fixed 30-day period the program counts', () => {
  assert.deepEqual(
    PERIOD_OPTIONS.map((o) => o.label),
    ['hour', 'day', 'week', 'month'],
  )
  assert.equal(PERIOD_OPTIONS.find((o) => o.label === 'month')!.key, '30days')
  assert.equal(perWords(2_592_000), 'every 30 days', 'the sentence stays exact')
})

test('wallet: one sheet with the stored authorization, a fresh one when the wallet refuses it', async () => {
  const run = (log: (string | null)[], fail: (token: string | null) => Error | null) => ({
    saved: [] as (string | null)[],
    stored: null as string | null,
    async load() {
      return this.stored
    },
    async save(t: string | null) {
      this.saved.push(t)
      this.stored = t
    },
    async run(token: string | null) {
      log.push(token)
      const err = fail(token)
      if (err) throw err
      return { result: 'sig', token: `t${log.length}` }
    },
  })
  // First time: no token, one session, the token is kept.
  const log: (string | null)[] = []
  const s = run(log, () => null)
  assert.equal(await withStoredAuthorization(s), 'sig')
  assert.deepEqual(log, [null])
  // Next time the token goes along: the wallet can skip "Connect".
  assert.equal(await withStoredAuthorization(s), 'sig')
  assert.deepEqual(log, [null, 't1'])
  // A token the wallet refuses: dropped, one fresh try.
  const log2: (string | null)[] = []
  const s2 = run(log2, (t) =>
    t === 'stale' ? Object.assign(new Error('authorization request failed'), { code: -1 }) : null,
  )
  s2.stored = 'stale'
  assert.equal(await withStoredAuthorization(s2), 'sig')
  assert.deepEqual(log2, ['stale', null])
  assert.equal(s2.stored, 't2')
  // A dismissal or a timeout is not the token's fault: no second sheet, token kept.
  for (const msg of [
    'User declined',
    'java.util.concurrent.TimeoutException: Timed out waiting for response with id=1',
  ]) {
    const log3: (string | null)[] = []
    const s3 = run(log3, () => new Error(msg))
    s3.stored = 'good'
    await assert.rejects(withStoredAuthorization(s3))
    assert.deepEqual(log3, ['good'])
    assert.equal(s3.stored, 'good')
  }
})

test('wallet: failures read as sentences, never as a Java exception', () => {
  const t = walletFailureText(
    new Error('java.util.concurrent.TimeoutException: Timed out waiting for response with id=1'),
    'revoke',
  )
  assert.equal(t, 'Seed Vault did not answer in time. Nothing was signed; the permission is still live.')
  assert.doesNotMatch(walletFailureText(new Error('java.lang.IllegalStateException: x'), 'revoke'), /java|Exception/)
  assert.match(walletFailureText(new Error('User declined'), 'grant'), /^Closed in Seed Vault/)
})

test('revoke: a Seed Vault failure says nothing was sent; a later one says it may still land', () => {
  const timeout = new WalletStepError(new Error('java.util.concurrent.TimeoutException: Timed out'))
  assert.match(revokeFailureText(timeout), /^Seed Vault did not answer in time\. Nothing was signed/)
  const server = Object.assign(new Error('That permission is already gone.'), { code: 'no_delegation', status: 404 })
  assert.equal(revokeFailureText(server), 'That permission is already gone.')
  assert.match(revokeFailureText(new Error('still_live')), /^Sent to the chain but not confirmed yet/)
})

test('digest picker: presses stay local, one save, and it never says "not set yet"', () => {
  const unset = digestPicker(null, null)
  assert.equal(unset.label, '08:00')
  assert.equal(unset.save, 'Send it at 08:00')
  assert.doesNotMatch(unset.sub, /not set/)
  const picking = digestPicker(8, 19)
  assert.equal(picking.save, 'Send it at 19:00')
  assert.equal(picking.sub, 'now 08:00, not saved')
  const saved = digestPicker(19, 19)
  assert.equal(saved.save, null)
  assert.equal(saved.sub, 'every day, your time')
  assert.equal(digestPicker(19, null).label, '19:00')
  assert.equal(digestPicker(0, 0).earlier, 23)
  assert.equal(digestPicker(23, 23).later, 0)
})

test('receipts: an ended permission is headed by its name and dates', () => {
  const at = (d: number, m = 8) => Date.UTC(2026, m, d, 12)
  assert.equal(endedHeader('cj7check', at(22), at(30), 180), 'cj7check · 22–30 Sep')
  assert.equal(endedHeader('cj7check', at(28), at(1, 9), 180), 'cj7check · 28 Sep – 1 Oct')
  assert.equal(endedHeader('Gym', at(30), at(30), 180), 'Gym · 30 Sep')
})
