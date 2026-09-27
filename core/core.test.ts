// Run: npm run test:core   (node --test with native type stripping; no bundler, no Android)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, explorerTx, remainingShare, resetsIn, shortAddr, tzOffsetMin } from './format.ts'
import { widgetView, type WidgetSnapshot } from './widget-model.ts'
import { checkForm, sanitizeAmount } from './mandate-form.ts'

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

test('widget: signed out, not loaded, live, stale', () => {
  assert.equal(widgetView(null, false, NOW).footer, 'Sign in to see your permissions')
  assert.equal(widgetView(null, true, NOW).footer, 'Open nuntius to load')
  const v = widgetView(snap(), true, NOW)
  assert.equal(v.title, '1 live permission')
  assert.deepEqual(v.rows, [{ left: 'Rent', right: '2.5/10 USDC · 1h 30m' }])
  assert.equal(v.footer, 'Clock in · streak 4')
  assert.equal(v.url, '/digest', 'tap goes to clock-in when not done today')
  assert.equal(widgetView(snap({ clockedInToday: true }), true, NOW).footer, 'Clocked in · streak 4')
  assert.equal(widgetView(snap({ clockedInToday: true }), true, NOW).url, '/')
  const s = widgetView(snap({ fetchedAt: NOW - 3 * 3_600_000 }), true, NOW)
  assert.equal(s.stale, true)
  assert.match(s.footer, /not refreshed$/)
})

test('widget: a refusal outranks everything else', () => {
  const v = widgetView(
    snap({ lastReceipt: { kind: 'refused', at: NOW, label: 'Gym', amount: null, symbol: 'USDC' } }),
    true,
    NOW,
  )
  assert.equal(v.footer, 'Refused by the chain: Gym')
})

test('widget: basic tier (no streak) shows the last pull', () => {
  const v = widgetView(snap({ streak: null, clockedInToday: null, liveCount: 2 }), true, NOW)
  assert.equal(v.title, '2 live permissions')
  assert.equal(v.footer, 'Last: Rent 7.5 USDC')
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
