/**
 * What the home-screen widget says, computed from the /api/widget snapshot.
 * Self-contained so it is testable without Android: the widget component only
 * lays these strings out.
 */
export interface WidgetSnapshot {
  rows: { label: string; remaining: string; cap: string; symbol: string; nextResetTs: number }[]
  liveCount: number
  lastReceipt: { kind: string; at: number; label: string | null; amount: string | null; symbol: string } | null
  streak: number | null
  clockedInToday: boolean | null
  /** When the app fetched it (ms). */
  fetchedAt: number
}

export interface WidgetView {
  title: string
  rows: { left: string; right: string }[]
  footer: string
  /** Where a tap goes. */
  url: string
  stale: boolean
}

const STALE_MS = 2 * 3_600_000

function countdown(nextResetTs: number, nowMs: number): string {
  const s = Math.floor(nextResetTs - nowMs / 1000)
  if (s <= 0) return 'resets now'
  const h = Math.floor(s / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d`
  return h > 0 ? `${h}h ${m}m` : `${Math.max(m, 1)}m`
}

export function widgetView(snap: WidgetSnapshot | null, signedIn: boolean, nowMs: number): WidgetView {
  if (!signedIn) {
    return { title: 'nuntius', rows: [], footer: 'Sign in to see your permissions', url: '/', stale: false }
  }
  if (!snap) {
    return { title: 'nuntius', rows: [], footer: 'Open nuntius to load', url: '/', stale: true }
  }
  const stale = nowMs - snap.fetchedAt > STALE_MS
  const title =
    snap.liveCount === 0 ? 'No live permissions' : `${snap.liveCount} live permission${snap.liveCount > 1 ? 's' : ''}`
  const rows = snap.rows.map((r) => ({
    left: r.label,
    right: `${r.remaining}/${r.cap} ${r.symbol} · ${countdown(r.nextResetTs, nowMs)}`,
  }))
  let footer: string
  if (snap.lastReceipt?.kind === 'refused') footer = `Refused by the chain: ${snap.lastReceipt.label ?? 'a pull'}`
  else if (snap.streak !== null && snap.clockedInToday === false) footer = `Clock in · streak ${snap.streak}`
  else if (snap.streak !== null) footer = `Clocked in · streak ${snap.streak}`
  else if (snap.lastReceipt?.kind === 'pull' && snap.lastReceipt.amount)
    footer = `Last: ${snap.lastReceipt.label ?? 'pull'} ${snap.lastReceipt.amount} ${snap.lastReceipt.symbol}`
  else footer = 'Every pull sends a receipt'
  if (stale) footer = `${footer} · not refreshed`
  const url = snap.streak !== null && snap.clockedInToday === false ? '/digest' : '/'
  return { title, rows, footer, url, stale }
}
