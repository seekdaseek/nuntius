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
  // The program counts fixed seconds, so this is "30 days", never "month".
  { key: '30days', label: '30 days' },
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

/** The starters to show: none unless the server offers SKR. */
export function startersFor(mints: readonly string[]): { starter: Starter; symbol: string; line: string }[] {
  const symbol = skrSymbol(mints)
  if (!symbol) return []
  return SKR_STARTERS.map((starter) => ({
    starter,
    symbol,
    line: `${starter.amount} ${symbol} every ${starter.period}, for ${starter.untilDays} days`,
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
