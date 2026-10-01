/**
 * Words for back permissions and subscription launches (Meteora DBC): the Back sentence,
 * buy and skip receipts, the card's launch line, and the launch page. Pure, so tested.
 */
import type { PeriodKey } from './mandate-form'

/** The quote tokens a back permission can spend: the server's USDC and SKR mints (mainnet). */
const QUOTES: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3: 'SKR',
}
export function quoteSymbolOf(mint: string): string | null {
  return QUOTES[mint] ?? null
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const AMOUNT = /^\d{1,15}(\.\d{1,6})?$/

export interface BackForm {
  pool: string
  amount: string
  period: PeriodKey
  untilDays: number
}

export function checkBack(f: BackForm): { ok: boolean; hint: string | null } {
  if (!f.pool.trim()) return { ok: false, hint: 'Paste the launch’s pool address' }
  if (!BASE58.test(f.pool.trim())) return { ok: false, hint: 'That is not a Solana address' }
  if (!AMOUNT.test(f.amount.trim()) || Number(f.amount) <= 0) return { ok: false, hint: 'How much per period?' }
  return { ok: true, hint: null }
}

const EVERY: Record<PeriodKey, string> = {
  hour: 'every hour',
  day: 'every day',
  week: 'every week',
  '30days': 'every 30 days',
}

/** "Back NATX: 5 USDC every week, for 90 days." */
export function backSentence(f: BackForm, token: string | null, quote: string): string {
  return `Back ${token ?? 'this launch'}: ${f.amount || '…'} ${quote} ${EVERY[f.period]}, for ${f.untilDays} days.`
}

/** A receipt row's line for a buy or a skip. */
export function buyLine(r: {
  kind: string
  amount: string | null
  symbol: string
  got?: string | null
}): string | null {
  if (r.kind === 'buy')
    return r.got ? `Bought ${r.got} for ${r.amount} ${r.symbol}` : `Bought for ${r.amount} ${r.symbol}`
  if (r.kind === 'skipped') return 'Skipped: the price moved more than 2%. Nothing was taken.'
  return null
}

export interface LaunchView {
  pool: string
  route: 'dbc' | 'damm_v2' | 'migrating'
  symbol: string | null
  progressPct: number
  committed: { backers: number; perWeek: string; symbol: string | null }
}

/** Where the launch is: on its curve, migrating, or trading in its regular pool. */
export function routeWords(l: Pick<LaunchView, 'route' | 'progressPct'>): string {
  if (l.route === 'dbc') return `Curve ${Math.floor(l.progressPct)}% filled`
  if (l.route === 'migrating') return 'Curve filled: moving to its regular pool'
  return 'Trading in its regular pool (DAMM v2)'
}

/** "3 backers commit 15 USDC a week" — the launch's recurring demand, from live permissions. */
export function demandWords(c: LaunchView['committed']): string {
  if (c.backers === 0) return 'No backers yet'
  return `${c.backers} ${c.backers === 1 ? 'backer commits' : 'backers commit'} ${c.perWeek} ${c.symbol ?? ''} a week`.replace(
    / +a week$/,
    ' a week',
  )
}

const SYMBOL_RE = /^[A-Z0-9]{2,10}$/
export function checkLaunch(f: { name: string; symbol: string }): { ok: boolean; hint: string | null } {
  if (!f.name.trim() || f.name.trim().length > 32) return { ok: false, hint: 'A name, up to 32 characters' }
  if (!SYMBOL_RE.test(f.symbol.trim().toUpperCase())) return { ok: false, hint: 'A symbol: 2–10 letters or digits' }
  return { ok: true, hint: null }
}
