/**
 * Words for back permissions and subscription launches (Meteora DBC): the Back sentence,
 * buy and skip receipts, the card's launch line, and the launch page. Pure, so tested.
 */
import type { PeriodKey } from './mandate-form'

/**
 * Launch and back screens show only when the server says so (`features.launches`).
 * An older server that does not send the field counts as off.
 */
export function launchesOn(list: { features?: { launches?: boolean } } | null | undefined): boolean {
  return list?.features?.launches === true
}

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

/**
 * Why a buy was skipped, in one sentence; the server sends the same words in the push
 * (server/src/receipts.ts skipWords). `why` is the server's cause; a receipt from before
 * causes were recorded has none, and was a slippage miss.
 */
export function skipWords(why: string | null | undefined): string {
  if (why === 'curve_full')
    return 'The curve filled before this buy. Nothing was taken; it buys in the regular pool once the token moves there.'
  if (why === 'no_room') return 'The curve had less room left than quoted. Nothing was taken.'
  if (why?.startsWith('error:')) return `The swap failed with error ${why.slice(6)}. Nothing was taken.`
  return 'The price moved more than 2%. Nothing was taken.'
}

/** A receipt row's line for a buy or a skip. */
export function buyLine(r: {
  kind: string
  amount: string | null
  symbol: string
  got?: string | null
  note?: string | null
}): string | null {
  if (r.kind === 'buy')
    return r.got ? `Bought ${r.got} for ${r.amount} ${r.symbol}` : `Bought for ${r.amount} ${r.symbol}`
  if (r.kind === 'skipped') {
    const w = skipWords(r.note)
    return `Skipped: ${w[0]!.toLowerCase()}${w.slice(1)}`
  }
  return null
}

export interface LaunchView {
  pool: string
  route: 'dbc' | 'damm_v2' | 'migrating'
  symbol: string | null
  progressPct: number
  committed: { backers: number; perWeek: string; symbol: string | null }
  /** Whose money it is, in the server's one sentence (server 6 Oct): the page and the link card say the same. */
  commitment?: { card: string; line: string }
}

/** Where the launch is: on its curve, migrating, or trading in its regular pool. */
export function routeWords(l: Pick<LaunchView, 'route' | 'progressPct'>): string {
  if (l.route === 'dbc') return `Curve ${Math.floor(l.progressPct)}% filled`
  if (l.route === 'migrating') return 'Curve filled: moving to its regular pool'
  return 'Trading in its regular pool (DAMM v2)'
}

/**
 * The launch's committed demand as the server words it (commitmentSentence): the builder's own
 * wallets named as the builder's, so "2 backers commit 42 SKR a week" no longer reads as outside
 * money when both are the builder's. A server without the sentence gets the plain count.
 */
export function commitmentWords(l: Pick<LaunchView, 'committed' | 'commitment'>): string {
  return l.commitment?.line || demandWords(l.committed)
}

/** "3 backers commit 15 USDC a week" — the plain count, for a server that does not send its sentence. */
export function demandWords(c: LaunchView['committed']): string {
  if (c.backers === 0) return 'No backers yet'
  return `${c.backers} ${c.backers === 1 ? 'backer commits' : 'backers commit'} ${c.perWeek} ${c.symbol ?? ''} a week`.replace(
    / +a week$/,
    ' a week',
  )
}

/**
 * What the creator signs up to, on the launch screen. Name and symbol are written on chain with
 * the metadata's update authority gone; the image is not on chain: it is a link in the JSON
 * nuntius serves at /m/<mint>.json, so the line does not call it permanent.
 */
export const LAUNCH_TERMS = 'You pay the pool’s accounts and sign once. Name and symbol are permanent on chain.'

/** What nuntius earns from a launch on its config; the launch screen says it before Seed Vault opens. */
export const FEES_LINE = 'nuntius earns 0.4% of curve trades and half of the locked pool’s fees after graduation.'

const SYMBOL_RE = /^[A-Z0-9]{2,10}$/
export function checkLaunch(f: { name: string; symbol: string }): { ok: boolean; hint: string | null } {
  if (!f.name.trim() || f.name.trim().length > 32) return { ok: false, hint: 'A name, up to 32 characters' }
  if (!SYMBOL_RE.test(f.symbol.trim().toUpperCase())) return { ok: false, hint: 'A symbol: 2–10 letters or digits' }
  return { ok: true, hint: null }
}
