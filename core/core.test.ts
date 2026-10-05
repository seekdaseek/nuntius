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
  staleLine,
  untilWords,
  weekSlots,
  whenWords,
  windowWords,
} from './home-model.ts'
import {
  applyParsed,
  applyStarter,
  checkForm,
  COULD_NOT_READ,
  FILLED_NOTE,
  isStarter,
  PERIOD_OPTIONS,
  sanitizeAmount,
  SKR_STARTERS,
  startersFor,
} from './mandate-form.ts'
import { isBlockhashExpired, landedAnyway } from './grant-errors.ts'
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
  assert.equal(staleLine(false, NOW, NOW), null)
  assert.equal(
    staleLine(true, NOW - 5 * 60_000, NOW),
    'The chain did not answer just now. This is your list as of 5m ago.',
  )
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
  const s = startersFor(['USDC', 'SKR'], true)
  assert.deepEqual(
    s.map((x) => [x.starter.title, x.symbol, x.line]),
    [
      ['Back a Seeker builder', 'SKR', '25 SKR every week, for 90 days'],
      ['Allowance in SKR', 'SKR', '50 SKR every week, for 30 days'],
    ],
  )
  assert.equal(startersFor(['tUSDC', 'tSKR'])[0]!.symbol, 'tSKR', 'the localnet stand-in')
  // v1.0.2: with launches off, "Back a Seeker builder" is the 25 SKR a week payment it was in v1.0.0;
  // with launches on, it opens the launch flow.
  assert.deepEqual(
    startersFor(['USDC', 'SKR']).map((x) => [x.starter.key, x.launch]),
    [
      ['builder', false],
      ['allowance', false],
    ],
  )
  assert.deepEqual(
    s.map((x) => [x.starter.key, x.launch]),
    [
      ['builder', true],
      ['allowance', false],
    ],
  )
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

test('Type it your way: Fill writes the parsed terms into the sentence and never the payee', () => {
  const payee = 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX'
  const before = { label: 'Old', payee, amount: '1', period: 'week' as const, untilDays: 30 }
  // "Pay Ana 5 cents a day for a week"
  const r = applyParsed(before, 'SKR', ['USDC', 'SKR'], {
    terms: { label: 'Ana', amount: '0.05', symbol: 'USDC', period: 'day', untilDays: 7 },
    reasons: {},
  })
  assert.deepEqual(r.form, { label: 'Ana', payee: '', amount: '0.05', period: 'day', untilDays: 7 })
  assert.equal(r.symbol, 'USDC')
  assert.equal(r.note, FILLED_NOTE)
  assert.equal(r.note, 'Filled from your words. Check every term.')
  assert.deepEqual(r.reasons, [])
  // The payee is emptied, so Approve stays off until it is pasted by hand.
  assert.equal(checkForm(r.form, null).field, 'payee')
  assert.ok(checkForm({ ...r.form, payee }, null).ok)

  // A refused amount stays empty with its reason; the token, period and end keep their value.
  const over = applyParsed(before, 'USDC', ['USDC', 'SKR'], {
    terms: { label: 'Ana' },
    reasons: { amount: 'At most 1 USDC a period in this beta.', untilDays: 'At most 90 days ahead.' },
  })
  assert.deepEqual(over.form, { label: 'Ana', payee: '', amount: '', period: 'week', untilDays: 30 })
  assert.equal(over.symbol, 'USDC')
  assert.deepEqual(over.reasons, ['At most 1 USDC a period in this beta.', 'At most 90 days ahead.'])
  assert.equal(checkForm({ ...over.form, payee }, null).field, 'amount', 'Approve stays off without an amount')

  // Nothing filled: the form is left exactly as it was and the app says it could not read the text.
  const none = applyParsed(before, 'USDC', ['USDC', 'SKR'], { terms: {}, reasons: { amount: 'No amount found.' } })
  assert.equal(none.form, before)
  assert.equal(none.filled, 0)
  assert.equal(none.note, COULD_NOT_READ)
  assert.deepEqual(none.reasons, ['No amount found.'])

  // Belt and braces: whatever a server sends, the app writes no address, no bad amount, no unknown token.
  const odd = applyParsed(before, 'USDC', ['USDC', 'SKR'], {
    terms: {
      label: `pay ${payee}`,
      amount: '0',
      symbol: 'BONK',
      period: 'year' as never,
      untilDays: 400,
    },
    reasons: {},
  })
  assert.equal(odd.form, before)
  assert.equal(odd.form.label, 'Old', 'a name with an address in it is never written')
  assert.deepEqual(odd.reasons, ['This app offers USDC and SKR.'])
})

test('a wallet error after the grant was sent: the app asks the chain before saying "not granted"', async () => {
  const pendingErr = Object.assign(new Error('the grant has not landed yet'), { code: 'not_on_chain_yet' })
  const isPending = (e: unknown) => (e as { code?: string }).code === 'not_on_chain_yet'
  const confirmAfter = (misses: number) => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls <= misses) throw pendingErr
      return { mandate: 'live' }
    }
    return { fn, calls: () => calls }
  }
  const walletErr = new Error('Transaction failed to confirm')
  const fast = { delayMs: 0 }
  // Device round 6: it had landed; the grant is live, not "not granted".
  let c = confirmAfter(0)
  assert.deepEqual(await landedAnyway(walletErr, true, c.fn, isPending, fast), { mandate: 'live' })
  // Still landing: asked again, a few times.
  c = confirmAfter(2)
  assert.deepEqual(await landedAnyway(walletErr, true, c.fn, isPending, fast), { mandate: 'live' })
  assert.equal(c.calls(), 3)
  c = confirmAfter(9)
  assert.equal(await landedAnyway(walletErr, true, c.fn, isPending, fast), null)
  assert.equal(c.calls(), 3, 'then the wallet error stands')
  // A cancel is asked once: no wait after a dismissed sheet.
  c = confirmAfter(9)
  assert.equal(
    await landedAnyway(new Error('User cancelled'), true, c.fn, isPending, { ...fast, cancelled: true }),
    null,
  )
  assert.equal(c.calls(), 1)
  // Nothing built, or refused by the app's own check: nothing reached Seed Vault, so nothing is asked.
  c = confirmAfter(0)
  assert.equal(await landedAnyway(walletErr, false, c.fn, isPending, fast), null)
  const mismatch = Object.assign(new Error('did not match'), { name: 'TxMismatch' })
  assert.equal(await landedAnyway(mismatch, true, c.fn, isPending, fast), null)
  assert.equal(c.calls(), 0)
  // A real refusal from the server (terms differ on chain) is not retried.
  let refusals = 0
  const refused = async () => {
    refusals++
    throw Object.assign(new Error('the on-chain delegation does not match'), { code: 'terms_mismatch' })
  }
  assert.equal(await landedAnyway(walletErr, true, refused, isPending, fast), null)
  assert.equal(refusals, 1)
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
  const { decideTap, TapLedger, tapUrl } = await import('./notification-tap.ts')
  const tapTarget = (r: Parameters<typeof decideTap>[0] | null, routedKey: string | null) => {
    if (!r) return null
    const ledger = new TapLedger()
    if (routedKey) ledger.add(routedKey)
    const d = decideTap(r, ledger)
    return 'routed' in d ? d.routed : null
  }
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
    fallback: false,
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
  // No url of ours (a collapsed group, or no data): the receipts list, not nothing.
  assert.deepEqual(tapTarget(res('f', {}), null), { id: 'f', key: 'f|', url: '/receipts', fallback: true })
  assert.equal(tapTarget(null, null), null)
  for (const bad of ['https://evil.example/x', '//evil.example', '/somewhere-else', 'alert']) {
    assert.equal(tapUrl(res('g', { url: bad })), null, bad)
  }
})

test('push tap: each tap routes once per process, and never a second tap is dropped', async () => {
  const { routeDeliveries, TapLedger, tapLogLine } = await import('./notification-tap.ts')
  type Source = 'launch' | 'listener' | 'resume'
  const push = (tag: string, kind: string, at: number) => ({
    notification: {
      request: {
        identifier: tag,
        content: { data: { url: `/alert?source=receipt&kind=${kind}&pda=${tag.slice(11)}&at=${at}`, tag } },
      },
    },
  })
  const run = (ledger: InstanceType<typeof TapLedger>, ...ds: [Source, ReturnType<typeof push>][]) =>
    routeDeliveries(
      ds.map(([source, response]) => ({ source, response })),
      ledger,
    ).map(({ decision }) => ('routed' in decision ? 'routed' : decision.skipped))

  // Cold start: the launch response and the listener event are one tap.
  const ledger = new TapLedger()
  const cold = push('permission:Hb7m', 'pull', 1)
  assert.deepEqual(run(ledger, ['launch', cold], ['listener', cold]), ['routed', 'already-routed'])
  // App open: the forwarder event and onNewIntent are one tap.
  const open = push('permission:5H3x', 'pull', 2)
  assert.deepEqual(run(ledger, ['listener', open], ['listener', open]), ['routed', 'already-routed'])
  // "Permission live" then "received" on one permission: two taps, both route.
  const live = push('permission:AAAA', 'granted', 3)
  const received = push('permission:AAAA', 'pull', 4)
  assert.deepEqual(run(ledger, ['listener', live], ['listener', received]), ['routed', 'routed'])
  // Two refused pushes on one permission (one tray tag), sent at 05:38 and 05:40: two taps.
  const refused1 = push('permission:Hb7m', 'refused', 5)
  const refused2 = push('permission:Hb7m', 'refused', 6)
  assert.deepEqual(run(ledger, ['listener', refused1], ['listener', refused2]), ['routed', 'routed'])
  // A tap whose listener event never came is picked up on return to the front.
  const lost = push('permission:5H3x', 'refused', 7)
  assert.deepEqual(run(ledger, ['resume', lost]), ['routed'])
  // Remount after BACK in the same process: the old tap is held but not routed again.
  assert.deepEqual(run(ledger, ['launch', received], ['resume', received]), ['already-routed', 'already-routed'])
  // A group summary or a push without a url opens the receipts list, every time:
  // the summary keeps one id for each tap on it, so it is never remembered.
  const bare = { notification: { request: { identifier: 'g', content: { data: {} } } } }
  const fallback = { routed: { id: 'g', key: 'g|', url: '/receipts', fallback: true } }
  assert.deepEqual(
    routeDeliveries(
      [
        { source: 'listener', response: bare },
        { source: 'listener', response: bare },
      ],
      ledger,
    ).map(({ decision }) => decision),
    [fallback, fallback],
  )
  assert.equal(ledger.has('g|'), false)
  // A url that is not an app screen is ignored: no fallback, no navigation there.
  const foreign = { notification: { request: { identifier: 'h', content: { data: { url: 'https://evil.example' } } } } }
  assert.deepEqual(
    routeDeliveries([{ source: 'listener', response: foreign }], ledger).map(({ decision }) => decision),
    [{ skipped: 'not-ours', key: 'h|' }],
  )
  assert.equal(
    tapLogLine({ source: 'launch', response: foreign }, { skipped: 'not-ours', key: 'h|' }),
    '[tap] launch h - -> skipped(not-ours)',
  )
  // The ledger is bounded: the oldest keys go first.
  const small = new TapLedger(2)
  small.add('a')
  small.add('b')
  small.add('c')
  assert.deepEqual([small.has('a'), small.has('b'), small.has('c')], [false, true, true])
  // One line per delivery.
  assert.equal(
    tapLogLine({ source: 'resume', response: lost }, { routed: { id: 'x', key: 'k', url: 'u', fallback: false } }),
    '[tap] resume permission:5H3x /alert?source=receipt&kind=refused&pda=5H3x&at=7 -> routed',
  )
  assert.equal(tapLogLine({ source: 'listener', response: bare }, fallback), '[tap] listener g - -> routed(fallback)')
  assert.equal(
    tapLogLine({ source: 'launch', response: received }, { skipped: 'already-routed', key: 'k' }),
    `[tap] launch permission:AAAA ${received.notification.request.content.data.url} -> skipped(already-routed)`,
  )
})

test('push tray: a new push with the app open leaves only itself in the tray', async () => {
  const { staleTrayIds } = await import('./notification-tap.ts')
  // Three permissions' pushes showing, then a refused push for the first one (same tag).
  assert.deepEqual(staleTrayIds(['permission:A', 'permission:B', 'permission:C'], 'permission:A'), [
    'permission:B',
    'permission:C',
  ])
  // The newest is not presented yet when the listener runs: everything else goes.
  assert.deepEqual(staleTrayIds(['permission:B', 'digest'], 'permission:A'), ['permission:B', 'digest'])
  // Alone in the tray: nothing to dismiss.
  assert.deepEqual(staleTrayIds(['permission:A'], 'permission:A'), [])
  assert.deepEqual(staleTrayIds([], 'permission:A'), [])
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

test('approve line: one short line above Approve; the rest behind "Why?"', async () => {
  const { approveLine } = await import('./allowance-copy.ts')
  const cases = [
    approveLine({ symbol: 'USDC', lifetimeTotal: '0.07', allowanceTotal: '0.07' }),
    approveLine({ symbol: 'USDC', lifetimeTotal: '1.68', allowanceTotal: '1.98' }),
    approveLine({ symbol: 'SKR', lifetimeTotal: '325', allowanceTotal: '1000325' }),
    approveLine({ symbol: 'SKR', lifetimeTotal: '325', allowanceTotal: null }),
    approveLine({ symbol: 'SKR', lifetimeTotal: '325', allowanceTotal: undefined }),
  ]
  assert.equal(cases[0], 'Seed Vault will show 0.07 USDC.')
  assert.equal(cases[1], 'Seed Vault will show 1.98 USDC in total.')
  // With " Why?" after it, one line at 13 px on a 360 dp phone holds about 50 characters.
  for (const c of cases) assert.ok(`${c} Why?`.length <= 50, c)
})

test('routes: one Clock in and one receipts list in the history; a finished form is replaced', async () => {
  const { grantedSlipUrl, isSingleScreen } = await import('./routes.ts')
  assert.equal(isSingleScreen('/digest?source=digest'), true)
  assert.equal(isSingleScreen('/receipts'), true)
  assert.equal(isSingleScreen('/'), true)
  assert.equal(isSingleScreen('/alert?kind=pull&sig=x'), false, 'every receipt is its own screen')
  const u = grantedSlipUrl({
    label: 'natXcheck',
    payee: 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX',
    delegationPda: 'Pda1',
    cap: '0.05',
    symbol: 'USDC',
    atMs: 1,
  })
  assert.match(u, /^\/alert\?source=grant&kind=granted&who=natXcheck&payee=ASCQ/)
  const { tapUrl } = await import('./notification-tap.ts')
  assert.equal(
    tapUrl({ notification: { request: { identifier: 'x', content: { data: { url: u } } } } }),
    u,
    'an app route',
  )
})
