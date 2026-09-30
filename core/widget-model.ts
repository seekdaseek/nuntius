/**
 * What the home-screen widget says, computed from the /api/widget snapshot.
 * Self-contained so it is testable without Android: the widget component only
 * lays these strings and shares out.
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

export interface WidgetRow {
  left: string
  right: string
  /** 0..1 of the cap taken this period: the meter's green fill. */
  takenShare: number
}

export interface WidgetView {
  title: string
  /** Top-right line, in signal colour: the clock-in state. */
  badge: string
  rows: WidgetRow[]
  /** Shown only when something needs saying; empty otherwise. */
  footer: string
  footerTone: 'refused' | 'muted'
  /** Where a tap goes. */
  url: string
  stale: boolean
}

const STALE_MS = 2 * 3_600_000

function share(remaining: string, cap: string): number {
  const c = Number(cap)
  const r = Number(remaining)
  if (!Number.isFinite(c) || !Number.isFinite(r) || c <= 0) return 0
  return Math.min(1, Math.max(0, (c - r) / c))
}

export function widgetView(
  snap: WidgetSnapshot | null,
  signedIn: boolean,
  nowMs: number,
  /** The last load failed (network, server or storage). */
  error = false,
): WidgetView {
  const base = { title: 'nuntius', badge: '', rows: [], footerTone: 'muted' as const, url: '/', stale: false }
  if (!signedIn) return { ...base, footer: 'Sign in to see your permissions' }
  if (!snap && error) return { ...base, footer: 'Could not load. Tap to open nuntius', stale: true }
  if (!snap) return { ...base, footer: 'Open nuntius to load', stale: true }

  const stale = nowMs - snap.fetchedAt > STALE_MS
  const rows = snap.rows.map((r) => ({
    left: r.label,
    right: `${r.remaining} of ${r.cap} ${r.symbol}`,
    takenShare: share(r.remaining, r.cap),
  }))
  let badge = ''
  if (snap.streak !== null) {
    badge = snap.clockedInToday ? `Clocked in, day ${snap.streak}` : `Clock in, day ${snap.streak + 1}`
  }
  let footer = ''
  let footerTone: 'refused' | 'muted' = 'muted'
  if (snap.lastReceipt?.kind === 'refused') {
    footer = `Refused by the chain: ${snap.lastReceipt.label ?? 'a pull'}`
    footerTone = 'refused'
  } else if (snap.liveCount === 0) footer = 'No live permissions'
  else if (snap.liveCount > rows.length) footer = `${snap.liveCount - rows.length} more in the app`
  if (stale) footer = footer ? `${footer}, not refreshed` : 'Not refreshed in 2 hours'
  const url = snap.streak !== null && snap.clockedInToday === false ? '/digest' : '/'
  return { title: 'nuntius', badge, rows, footer, footerTone, url, stale }
}
