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
