/**
 * The words and numbers the redesigned screens show, computed from live API
 * data. Pure and self-contained (no imports) so `node --test` runs it directly.
 */

/** "0.05" at 6 decimals -> 50000n. Accepts only what formatUnits produces. */
export function toUnits(text: string, decimals: number): bigint {
  const [w = '0', f = ''] = text.split('.')
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

export function fromUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString()
  const d = units.toString().padStart(decimals + 1, '0')
  const frac = d.slice(-decimals).replace(/0+$/, '')
  return `${d.slice(0, -decimals)}${frac ? `.${frac}` : ''}`
}

export interface Meter {
  /** 0..1 of the cap already taken this period — the green fill. */
  takenShare: number
  taken: string
  left: string
}

/** The cap meter: fill is what was taken, the stop line is the cap. Exact, no float drift in the labels. */
export function meter(cap: string | null, remaining: string | null, decimals: number): Meter {
  if (!cap) return { takenShare: 0, taken: '0', left: '0' }
  const c = toUnits(cap, decimals)
  const r = remaining === null ? c : toUnits(remaining, decimals)
  const t = c > r ? c - r : 0n
  const share = c === 0n ? 0 : Number((t * 10_000n) / c) / 10_000
  return { takenShare: share, taken: fromUnits(t, decimals), left: fromUnits(r, decimals) }
}

/** "a day", "an hour", "a week", "every 30 days". */
export function perWords(periodS: number | null): string {
  if (periodS === 3_600) return 'an hour'
  if (periodS === 86_400) return 'a day'
  if (periodS === 604_800) return 'a week'
  if (periodS === 2_592_000) return 'every 30 days'
  if (periodS && periodS % 86_400 === 0) return `every ${periodS / 86_400} days`
  if (periodS && periodS % 3_600 === 0) return `every ${periodS / 3_600} hours`
  return periodS ? `every ${periodS} seconds` : ''
}

/** "today", "this hour", "this week", "this period" — the window the meter shows. */
export function windowWords(periodS: number | null): string {
  if (periodS === 86_400) return 'today'
  if (periodS === 3_600) return 'this hour'
  if (periodS === 604_800) return 'this week'
  return 'this period'
}

/** "6h 12m", "3d 4h", "41m", "30s". */
export function span(untilTs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(untilTs - nowMs / 1000))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

export interface LiveForHero {
  label: string
  cap: string
  remaining: string | null
  symbol: string
  decimals: number
  nextResetTs: number | null
}

/**
 * The next money movement, as one sentence. The executor pays at the start of
 * each period, so a mandate whose whole cap is still unused pays now; any other
 * pays at its next reset.
 */
export function nextMovement(live: LiveForHero[], nowMs: number): string {
  if (live.length === 0) return 'Grant your first permission. One approval, and it runs on its own.'
  let best: { at: number; text: string } | null = null
  for (const m of live) {
    const full = m.remaining !== null && toUnits(m.remaining, m.decimals) >= toUnits(m.cap, m.decimals)
    const at = full ? 0 : (m.nextResetTs ?? Infinity)
    const when = full ? 'now' : m.nextResetTs ? `in ${span(m.nextResetTs, nowMs)}` : 'at the next reset'
    const text = `${m.label} gets ${m.cap} ${m.symbol} ${when}.`
    if (!best || at < best.at) best = { at, text }
  }
  return best!.text
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const count = (n: number) => WORDS[n] ?? String(n)

/** "Two permissions live. Nothing refused today." */
export function summaryLine(liveCount: number, refusedToday: number, foreignCount: number): string {
  const live = `${count(liveCount)} permission${liveCount === 1 ? '' : 's'} live.`
  const refused =
    refusedToday === 0
      ? 'Nothing refused today.'
      : `${count(refusedToday)} pull${refusedToday === 1 ? '' : 's'} refused by the chain today.`
  const other = foreignCount > 0 ? ` ${count(foreignCount)} held by other apps.` : ''
  return `${live}${other} ${refused}`
}

export type SlotState = 'punched' | 'today' | 'todayPunched' | 'missed' | 'future'
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function shift(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + by)
  return d.toISOString().slice(0, 10)
}

/** Seven punch-card slots: four days back, today, two ahead. */
export function weekSlots(days: string[], today: string): { label: string; day: string; state: SlotState }[] {
  const set = new Set(days)
  return [-4, -3, -2, -1, 0, 1, 2].map((off) => {
    const day = shift(today, off)
    const label = DOW[new Date(`${day}T00:00:00Z`).getUTCDay()]!
    let state: SlotState
    if (off > 0) state = 'future'
    else if (off === 0) state = set.has(day) ? 'todayPunched' : 'today'
    else state = set.has(day) ? 'punched' : 'missed'
    return { label, day, state }
  })
}

/** Which dot a digest line gets. */
export function lineTone(line: string): 'moved' | 'refused' | 'foreign' | 'neutral' {
  if (line.startsWith('Refused')) return 'refused'
  if (line.includes('outside nuntius')) return 'foreign'
  if (line.includes(' received ')) return 'moved'
  return 'neutral'
}

/** "Tuesday 30 September" in the device's calendar, English. */
export function longDate(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60_000)
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`
}

/** "30 Sep at 02:00" local. */
export function whenWords(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60_000)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} at ${hh}:${mm}`
}

/** "30 Oct" for an expiry N days from now. */
export function untilWords(nowMs: number, days: number, tzOffsetMin: number): string {
  const d = new Date(nowMs + days * 86_400_000 + tzOffsetMin * 60_000)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`
}

/** First letter for the tinted initial tile. */
export function initial(label: string): string {
  const c = label.trim().charAt(0)
  return c ? c.toUpperCase() : '?'
}
