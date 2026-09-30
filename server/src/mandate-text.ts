/**
 * The mandate in plain language, and the parsing that turns what a person types
 * into exact base units. The sentence is what the user reads before the one
 * Seed Vault approval, so it must never round, never say "monthly" for a fixed
 * 30-day period, and never promise what the chain does not enforce.
 */

export const PERIODS = {
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  // The program counts fixed seconds, not calendar months — say "30 days".
  '30days': 2_592_000,
} as const
export type PeriodKey = keyof typeof PERIODS

const PERIOD_WORDS: Record<number, string> = {
  3_600: 'every hour',
  86_400: 'every day',
  604_800: 'every week',
  2_592_000: 'every 30 days',
}

export function periodWords(seconds: number): string {
  const known = PERIOD_WORDS[seconds]
  if (known) return known
  const unit = (n: number, one: string) => (n === 1 ? `every ${one}` : `every ${n} ${one}s`)
  if (seconds % 86_400 === 0) return unit(seconds / 86_400, 'day')
  if (seconds % 3_600 === 0) return unit(seconds / 3_600, 'hour')
  if (seconds % 60 === 0) return unit(seconds / 60, 'minute')
  return unit(seconds, 'second')
}

/** "12.5" at 6 decimals -> 12500000n. Rejects more precision than the mint has. */
export function parseUnits(text: string, decimals: number): bigint {
  const t = text.trim()
  if (!/^\d{1,15}(\.\d+)?$/.test(t)) throw new Error('amount must be a plain number like 10 or 2.50')
  const [whole = '0', frac = ''] = t.split('.')
  if (frac.length > decimals) throw new Error(`amount has more than ${decimals} decimal places`)
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')
  if (units <= 0n) throw new Error('amount must be greater than zero')
  if (units > 18_446_744_073_709_551_615n) throw new Error('amount exceeds u64')
  return units
}

/** 12500000n at 6 decimals -> "12.5". Exact; never rounds. */
export function formatUnits(baseUnits: bigint, decimals: number): string {
  if (decimals === 0) return baseUnits.toString()
  const negative = baseUnits < 0n
  const digits = (negative ? -baseUnits : baseUnits).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** "a day", "an hour", "a week", "every 30 days" — the rate form of a period. */
export function perWords(seconds: number): string {
  if (seconds === 3_600) return 'an hour'
  if (seconds === 86_400) return 'a day'
  if (seconds === 604_800) return 'a week'
  return periodWords(seconds)
}

export function shortDate(unixS: number): string {
  const d = new Date(unixS * 1000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

export function shortAddress(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function dateWords(unixS: number): string {
  const d = new Date(unixS * 1000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export interface MandateWords {
  label: string
  payee: string
  amountBaseUnits: bigint
  decimals: number
  symbol: string
  periodLengthS: number
  /** Unix seconds; 0 = no end. */
  expiryTs: number
}

/**
 * The sentence shown on the grant sheet, the mandate card and the receipt.
 * Three parts, always in this order: what it may do, what the chain refuses,
 * how to stop it.
 */
export function describeMandate(m: MandateWords): {
  headline: string
  schedule: string
  guarantee: string
  exit: string
  enforce: string
} {
  const amount = `${formatUnits(m.amountBaseUnits, m.decimals)} ${m.symbol}`
  const who = m.label ? `${m.label} (${shortAddress(m.payee)})` : shortAddress(m.payee)
  const until = m.expiryTs > 0 ? `, until ${dateWords(m.expiryTs)}` : ''
  return {
    headline: `${who} can receive up to ${amount} ${periodWords(m.periodLengthS)}${until}.`,
    // The executor pays at the start of each period, and the first period starts at approval.
    schedule: `nuntius sends the first ${amount} right after you approve, then one payment ${periodWords(m.periodLengthS)}.`,
    guarantee: `Anything above ${amount} in a period is refused by the Solana program itself, not by nuntius.`,
    exit: 'Revoke any time with one approval. Nothing is taken without a receipt on this phone.',
    enforce: `The chain will enforce this: at most ${amount} ${perWords(m.periodLengthS)} to ${shortAddress(m.payee)}${
      m.expiryTs > 0 ? `, until ${shortDate(m.expiryTs)}` : ''
    }. A pull above that fails with error 0x190.`,
  }
}

const LABEL_RE = /^[\p{L}\p{N} .,'&()\-]{1,40}$/u
export function cleanLabel(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string') throw new Error('label must be text')
  const t = raw.trim().replace(/\s+/g, ' ')
  if (!LABEL_RE.test(t)) throw new Error('label: up to 40 letters, digits and simple punctuation')
  return t
}
