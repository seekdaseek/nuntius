/**
 * Client-side checks for the rule-creation form. They only decide whether the
 * Authorize button is enabled and what hint to show; the server re-validates
 * everything and its preview sentence is the one the user approves.
 */
export type PeriodKey = 'hour' | 'day' | 'week' | '30days'

export const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  { key: 'hour', label: 'hour' },
  { key: 'day', label: 'day' },
  { key: 'week', label: 'week' },
  // The chip says "month", as in the mockup. The program counts fixed seconds, so
  // the sentence above it and the chain's line both say "every 30 days".
  { key: '30days', label: 'month' },
]

export const UNTIL_OPTIONS = [7, 30, 90] as const

export interface MandateForm {
  label: string
  payee: string
  amount: string
  period: PeriodKey
  untilDays: number
}

export interface FormCheck {
  ok: boolean
  field: 'payee' | 'amount' | 'label' | null
  hint: string | null
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const AMOUNT = /^\d{1,15}(\.\d{1,6})?$/
/** An address anywhere in a string: a parsed name with one in it is never written. */
const BASE58_ANY = /[1-9A-HJ-NP-Za-km-z]{32,44}/

export function checkForm(f: MandateForm, owner: string | null): FormCheck {
  if (f.label.length > 40) return { ok: false, field: 'label', hint: 'Keep the name under 40 characters' }
  const payee = f.payee.trim()
  if (!payee) return { ok: false, field: 'payee', hint: 'Paste the address that should receive the payments' }
  if (!BASE58.test(payee)) return { ok: false, field: 'payee', hint: 'That is not a Solana address' }
  if (owner && payee === owner) return { ok: false, field: 'payee', hint: 'That is your own wallet' }
  const amount = f.amount.trim()
  if (!amount) return { ok: false, field: 'amount', hint: 'How much per period?' }
  if (!AMOUNT.test(amount)) return { ok: false, field: 'amount', hint: 'A plain number, up to 6 decimals' }
  if (Number(amount) <= 0) return { ok: false, field: 'amount', hint: 'Must be more than zero' }
  return { ok: true, field: null, hint: null }
}

/** Strips anything a numeric keyboard or a paste can add that is not a digit or one dot. */
export function sanitizeAmount(raw: string): string {
  const cleaned = raw.replace(',', '.').replace(/[^\d.]/g, '')
  const [whole, ...rest] = cleaned.split('.')
  return rest.length ? `${whole}.${rest.join('').slice(0, 6)}` : (whole ?? '')
}

/**
 * One-tap SKR starters on New permission. A starter fills the sentence (name,
 * amount, token, period, duration); the payee is never prefilled, so it is
 * always typed or pasted by hand. Both amounts sit under the SKR beta ceiling
 * of 55 SKR per period (server/src/mandate-config.ts).
 */
export interface Starter {
  key: 'builder' | 'allowance'
  title: string
  label: string
  amount: string
  period: PeriodKey
  untilDays: number
}

export const SKR_STARTERS: readonly Starter[] = [
  {
    key: 'builder',
    title: 'Back a Seeker builder',
    label: 'Seeker builder',
    amount: '25',
    period: 'week',
    untilDays: 90,
  },
  { key: 'allowance', title: 'Allowance in SKR', label: 'Allowance', amount: '50', period: 'week', untilDays: 30 },
]

/**
 * The server's SKR symbol, or null when it does not offer SKR. `tSKR` is the
 * localnet test mint that stands in for SKR in the preview server.
 */
export function skrSymbol(mints: readonly string[]): string | null {
  return mints.find((m) => m === 'SKR' || m === 'tSKR') ?? null
}

/**
 * The starters to show: none unless the server offers SKR. "Back a Seeker builder"
 * is the 25 SKR a week recurring payment to a builder's wallet (v1.0.0, proven on
 * mainnet 30 Sep). When the server turns launches on, it opens the launch flow
 * instead (`launch: true`): each week's pull then buys the builder's token.
 */
export function startersFor(
  mints: readonly string[],
  launches = false,
): { starter: Starter; symbol: string; line: string; launch: boolean }[] {
  const symbol = skrSymbol(mints)
  if (!symbol) return []
  return SKR_STARTERS.map((starter) => ({
    starter,
    symbol,
    line: `${starter.amount} ${symbol} every ${starter.period}, for ${starter.untilDays} days`,
    launch: launches && starter.key === 'builder',
  }))
}

/** The form after a starter tap: everything but the payee comes from the starter. */
export function applyStarter(f: MandateForm, s: Starter): MandateForm {
  return { label: s.label, payee: f.payee, amount: s.amount, period: s.period, untilDays: s.untilDays }
}

/** True while the form still says exactly what the starter filled in. */
export function isStarter(f: MandateForm, symbol: string, current: string, s: Starter): boolean {
  return (
    symbol === current &&
    f.label === s.label &&
    f.amount === s.amount &&
    f.period === s.period &&
    f.untilDays === s.untilDays
  )
}

/**
 * "Type it your way" (v1.0.2). The server reads the sentence with a model and
 * checks every term with plain code (server/src/parse-permission.ts); this is
 * what came back. Only terms that passed are present; a refused or missing one
 * has a one-line reason instead.
 */
export interface ParsedTerms {
  terms: Partial<{ label: string; amount: string; symbol: string; period: PeriodKey; untilDays: number }>
  reasons: Partial<Record<'label' | 'amount' | 'symbol' | 'period' | 'untilDays', string>>
}

export const MAX_WORDS = 280
export const FILLED_NOTE = 'Filled from your words. Check every term.'
export const COULD_NOT_READ = 'Could not read that text. Fill in the form as before.'

const REASON_ORDER = ['label', 'amount', 'symbol', 'period', 'untilDays'] as const

/**
 * The form after Fill. It writes the parsed terms into the sentence and never the
 * payee: the payee is emptied, so Approve stays off until an address is pasted by
 * hand. The name and the amount are written or emptied; the token, the period and
 * the end keep their current value when the text gave none that passed. Nothing
 * filled means the form is left exactly as it was.
 */
export function applyParsed(
  f: MandateForm,
  symbol: string,
  mints: readonly string[],
  p: ParsedTerms,
): { form: MandateForm; symbol: string; filled: number; note: string; reasons: string[] } {
  const t = p.terms ?? {}
  const reasons: string[] = REASON_ORDER.map((k) => p.reasons?.[k]).filter((r): r is string => Boolean(r))
  const sym = t.symbol && mints.includes(t.symbol) ? t.symbol : null
  if (t.symbol && !sym) reasons.push(`This app offers ${mints.join(' and ')}.`)
  const amount = typeof t.amount === 'string' && AMOUNT.test(t.amount) && Number(t.amount) > 0 ? t.amount : null
  const period = PERIOD_OPTIONS.some((o) => o.key === t.period) ? (t.period as PeriodKey) : null
  const untilDays =
    Number.isInteger(t.untilDays) && (t.untilDays as number) >= 1 && (t.untilDays as number) <= 90
      ? (t.untilDays as number)
      : null
  const label = typeof t.label === 'string' && t.label.length <= 40 && !BASE58_ANY.test(t.label) ? t.label : null
  const filled = [label, amount, sym, period, untilDays].filter((v) => v !== null).length
  if (filled === 0) return { form: f, symbol, filled, note: COULD_NOT_READ, reasons }
  return {
    form: {
      label: label ?? '',
      payee: '',
      amount: amount ?? '',
      period: period ?? f.period,
      untilDays: untilDays ?? f.untilDays,
    },
    symbol: sym ?? symbol,
    filled,
    note: FILLED_NOTE,
    reasons,
  }
}
