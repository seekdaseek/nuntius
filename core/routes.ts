/**
 * Where the app goes, as plain functions so the rules are testable.
 */

/** Screens there is only ever one of: a tap that opens one goes back to it, not a second copy. */
const SINGLE = ['/', '/digest', '/receipts']

export function isSingleScreen(url: string): boolean {
  return SINGLE.includes(url.split('?')[0]!)
}

/**
 * The "Permission live" slip that replaces New permission once a grant is on
 * chain. Replacing (not pushing) takes the finished form out of the history,
 * so BACK from any receipt after it goes home (device check 5, 1 Oct).
 */
export function grantedSlipUrl(g: {
  label: string
  payee: string
  delegationPda: string
  cap: string
  symbol: string
  atMs: number
}): string {
  const q = new URLSearchParams({
    source: 'grant',
    kind: 'granted',
    who: g.label,
    payee: g.payee,
    pda: g.delegationPda,
    amount: g.cap,
    symbol: g.symbol,
    at: String(g.atMs),
  })
  return `/alert?${q.toString()}`
}
