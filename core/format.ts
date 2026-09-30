/**
 * Display helpers shared by screens and the home-screen widget. Pure and
 * self-contained (no imports) so they run under `node --test` directly.
 */

/** "resets in 3h 12m" — never a clock time, which would need the user's timezone right. */
export function resetsIn(nextResetTs: number | null, nowMs: number): string {
  if (!nextResetTs) return 'reset time unknown'
  const s = Math.floor(nextResetTs - nowMs / 1000)
  if (s <= 0) return 'resets now'
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  if (d > 0) return `resets in ${d}d ${h}h`
  if (h > 0) return `resets in ${h}h ${m}m`
  if (m > 0) return `resets in ${m}m`
  return `resets in ${s}s`
}

export function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a
}

/** 0..1 share of the cap still available; exact decimal strings in, no float drift out of range. */
export function remainingShare(remaining: string | null, cap: string | null): number {
  if (!remaining || !cap) return 0
  const r = Number(remaining)
  const c = Number(cap)
  if (!Number.isFinite(r) || !Number.isFinite(c) || c <= 0) return 0
  return Math.min(1, Math.max(0, r / c))
}

export function ago(atMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - atMs) / 1000))
  if (s < 60) return 'just now'
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** Minutes east of UTC, the way the server's clock-in and digest expect it. */
export function tzOffsetMin(date: Date = new Date()): number {
  return -date.getTimezoneOffset()
}

export function explorerTx(signature: string, cluster: string | undefined): string | null {
  // Localnet signatures do not exist on any public explorer; say so rather than link to nothing.
  if (cluster === 'localnet') return null
  return `https://explorer.solana.com/tx/${signature}${cluster === 'devnet' ? '?cluster=devnet' : ''}`
}

/** "1 day", "2 days": a count with its noun. */
export function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`
}
