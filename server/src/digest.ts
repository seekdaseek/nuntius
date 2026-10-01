/**
 * The daily loop: a morning digest of what the wallet's permissions did, and a
 * clock-in streak for the days the user looked. Pure functions — the scheduler
 * and the store feed them; nothing here touches the network.
 */
import { formatUnits, shortAddress } from './mandate-text.js'

export type EventKind = 'pull' | 'refused' | 'granted' | 'revoked' | 'expired' | 'buy' | 'skipped'

export interface LedgerEvent {
  kind: EventKind
  at: number // unix ms
  delegationPda: string
  delegatee: string
  label: string | null
  amountBaseUnits: string | null
  decimals: number
  symbol: string
  signature: string | null
  /** 'nuntius' when our executor acted; 'other' when another app's delegatee did. */
  actor: 'nuntius' | 'other'
  /** A buy (back permission): what it bought, delivered to the backer's own account. */
  outBaseUnits?: string | null
  outDecimals?: number | null
  outSymbol?: string | null
}

export interface LiveMandate {
  delegationPda: string
  label: string | null
  delegatee: string
  remainingBaseUnits: string
  capBaseUnits: string
  decimals: number
  symbol: string
  nextResetTs: number // unix s
  expiryTs: number // unix s, 0 = none
}

export interface Digest {
  title: string
  body: string
  lines: string[]
  totals: { pulls: number; refused: number; moved: Record<string, string>; granted: number; revoked: number }
  expiringSoon: string[]
}

const who = (e: { label: string | null; delegatee: string }) => e.label ?? shortAddress(e.delegatee)

/**
 * Summarises what happened since `sinceMs`: the previous digest when there was
 * one, else the last 24 hours. The title is the one line a lock screen shows,
 * so it leads with anything that needs attention, and it names its window
 * truthfully (device check 10, 1 Oct: "2 pulls refused … overnight" counted a
 * refusal from before the previous digest).
 */
export function buildDigest(
  events: LedgerEvent[],
  live: LiveMandate[],
  nowMs: number,
  sinceMs: number | null = null,
): Digest {
  const since = sinceMs ?? nowMs - 24 * 3600 * 1000
  const window = sinceMs === null ? 'in the last 24 hours' : 'since your last digest'
  const recent = events.filter((e) => e.at >= since && e.at <= nowMs).sort((a, b) => a.at - b.at)
  const pulls = recent.filter((e) => e.kind === 'pull')
  const refused = recent.filter((e) => e.kind === 'refused')
  const granted = recent.filter((e) => e.kind === 'granted')
  const revoked = recent.filter((e) => e.kind === 'revoked' || e.kind === 'expired')

  const movedBy: Record<string, { units: bigint; decimals: number }> = {}
  for (const p of pulls) {
    const cur = movedBy[p.symbol] ?? { units: 0n, decimals: p.decimals }
    cur.units += BigInt(p.amountBaseUnits ?? '0')
    movedBy[p.symbol] = cur
  }
  const moved: Record<string, string> = {}
  for (const [sym, v] of Object.entries(movedBy)) moved[sym] = formatUnits(v.units, v.decimals)
  const movedText =
    Object.entries(moved)
      .map(([s, a]) => `${a} ${s}`)
      .join(' and ') || 'nothing'

  const lines: string[] = []
  for (const r of refused) lines.push(`Refused by the chain: ${who(r)} asked above its cap.`)
  for (const g of granted) {
    lines.push(
      g.actor === 'other' ? `New permission: ${who(g)} (granted outside nuntius — check it).` : `Granted: ${who(g)}.`,
    )
  }
  for (const p of pulls) {
    lines.push(`${who(p)} received ${formatUnits(BigInt(p.amountBaseUnits ?? '0'), p.decimals)} ${p.symbol}.`)
  }
  for (const r of revoked) lines.push(`${r.kind === 'expired' ? 'Expired' : 'Revoked'}: ${who(r)}.`)
  for (const m of live) {
    lines.push(
      `${who(m)}: ${formatUnits(BigInt(m.remainingBaseUnits), m.decimals)} of ${formatUnits(BigInt(m.capBaseUnits), m.decimals)} ${m.symbol} left this period.`,
    )
  }

  const weekS = 7 * 86_400
  const nowS = Math.floor(nowMs / 1000)
  const expiringSoon = live.filter((m) => m.expiryTs > 0 && m.expiryTs - nowS <= weekS).map((m) => who(m))

  let title: string
  if (refused.length > 0)
    title = `${refused.length} pull${refused.length > 1 ? 's' : ''} refused by the chain ${window}`
  else if (granted.some((g) => g.actor === 'other')) title = 'A new permission appeared on your wallet'
  else if (pulls.length > 0) title = `${pulls.length} pull${pulls.length > 1 ? 's' : ''} ${window}: ${movedText} moved`
  else title = `Nothing moved ${window}`

  const capsLeft =
    live.length === 0
      ? 'No live permissions.'
      : `${live.length} live permission${live.length > 1 ? 's' : ''}, all inside their caps.`
  const body = [
    capsLeft,
    expiringSoon.length ? `Expiring within 7 days: ${expiringSoon.join(', ')}.` : '',
    'Tap to clock in.',
  ]
    .filter(Boolean)
    .join(' ')

  return {
    title,
    body,
    lines,
    totals: { pulls: pulls.length, refused: refused.length, moved, granted: granted.length, revoked: revoked.length },
    expiringSoon,
  }
}

/** Local calendar day for a timestamp, given the user's UTC offset in minutes (e.g. +180 for EEST). */
export function localDay(ms: number, tzOffsetMin: number): string {
  return new Date(ms + tzOffsetMin * 60_000).toISOString().slice(0, 10)
}

function prevDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Consecutive clock-in days ending today — or ending yesterday, so the streak
 * is not shown as broken before the user has had a chance to clock in today.
 */
export function computeStreak(
  days: string[],
  today: string,
): { current: number; clockedInToday: boolean; best: number } {
  const set = new Set(days)
  const clockedInToday = set.has(today)
  let cursor = clockedInToday ? today : prevDay(today)
  let current = 0
  while (set.has(cursor)) {
    current++
    cursor = prevDay(cursor)
  }
  const sorted = [...set].sort()
  let best = 0
  let run = 0
  let last: string | null = null
  for (const d of sorted) {
    run = last !== null && prevDay(d) === last ? run + 1 : 1
    best = Math.max(best, run)
    last = d
  }
  return { current, clockedInToday, best }
}

/** Is it time to send today's digest? Fires once per local day at or after the chosen hour. */
export function digestDue(
  nowMs: number,
  pref: { hour: number; tzOffsetMin: number; lastSentDay: string | null; savedAtMs?: number | null },
): boolean {
  const offsetMs = pref.tzOffsetMin * 60_000
  const localMs = nowMs + offsetMs
  const today = new Date(localMs).toISOString().slice(0, 10)
  // Today's send time, at the chosen local hour, in UTC.
  const slot = Math.floor(localMs / 86_400_000) * 86_400_000 + pref.hour * 3_600_000 - offsetMs
  // Only a slot that comes after the hour was chosen. Saving 19:00 at 18:39
  // sends at 19:00; it never counts as "08:00 today, overdue" (device check 10,
  // 30 Sep: an hour saved on the way to 19:00 sent the digest at 18:39, and
  // with today marked sent, 19:00 stayed silent).
  return nowMs >= slot && slot >= (pref.savedAtMs ?? 0) && pref.lastSentDay !== today
}
