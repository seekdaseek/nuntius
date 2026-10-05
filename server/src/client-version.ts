/**
 * Which app build is calling. The app sends its version (app.json) on every API call in
 * `x-nuntius-client`. Subscription launches need 1.1.0 or later: the v1.0.2 build that
 * Clock In judges install sends no header, so it never sees them, whatever the server's
 * MANDATE_LAUNCHES says.
 */
export const CLIENT_HEADER = 'x-nuntius-client'
export const LAUNCHES_MIN_CLIENT = '1.1.0'

/** "1.1.0" -> [1, 1, 0]; anything that is not exactly three plain numbers is null. */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True only for a well-formed version at or above `min`. A missing or garbled header is false. */
export function clientAtLeast(header: unknown, min: string = LAUNCHES_MIN_CLIENT): boolean {
  const v = parseVersion(header)
  const w = parseVersion(min)
  if (!v || !w) return false
  for (let i = 0; i < 3; i++) if (v[i] !== w[i]) return v[i]! > w[i]!
  return true
}

/** Launches are on for this request: the server flag, and a client new enough to show them. */
export function launchesFor(serverFlag: boolean, header: unknown): boolean {
  return serverFlag && clientAtLeast(header)
}
