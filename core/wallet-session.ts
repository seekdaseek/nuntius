/**
 * One Seed Vault sheet per action. An authorize without an auth_token makes
 * Seed Vault ask which wallet to use first ("Connect"), then show the
 * transaction: two sheets (device check 11, 30 Sep). With the token from the
 * last authorize it goes straight to the transaction.
 *
 * A stored token can go stale (the wallet rotated it, or forgot the app), and
 * replaying a stale one used to leave every later request failing (66ab4e8).
 * So a token the wallet refuses is dropped and the request is made once more
 * without one: the worst case is the old two sheets, never a dead end.
 */
export interface StoredAuthorization<T> {
  load(): Promise<string | null>
  save(token: string | null): Promise<void>
  /** One wallet session: authorize (with the token when given), then the work. */
  run(token: string | null): Promise<{ result: T; token: string }>
}

export async function withStoredAuthorization<T>(s: StoredAuthorization<T>): Promise<T> {
  const token = await s.load().catch(() => null)
  try {
    const r = await s.run(token)
    await s.save(r.token).catch(() => {})
    return r.result
  } catch (e) {
    if (!token || !isRefusedAuthorization(e)) throw e
    await s.save(null).catch(() => {})
    const r = await s.run(null)
    await s.save(r.token).catch(() => {})
    return r.result
  }
}

function text(e: unknown): string {
  return (e instanceof Error ? e.message : String(e ?? '')).toLowerCase()
}
function code(e: unknown): unknown {
  return e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined
}

export function isUserCancel(e: unknown): boolean {
  const m = text(e)
  return m.includes('cancel') || m.includes('declined') || m.includes('session closed') || m.includes('session_closed')
}

export function isWalletTimeout(e: unknown): boolean {
  return /timeoutexception|timed out|timeout/.test(text(e))
}

/** The wallet refused the stored authorization itself (not the user, not a timeout). */
export function isRefusedAuthorization(e: unknown): boolean {
  if (isUserCancel(e) || isWalletTimeout(e)) return false
  const c = code(e)
  if (c === -1 || c === 'ERROR_AUTHORIZATION_FAILED') return true
  return /authoriz|auth_token|auth token/.test(text(e))
}

/**
 * A wallet failure in words, never a Java exception. Everything here happened
 * before anything was sent, so the permission is unchanged.
 */
export function walletFailureText(e: unknown, action: 'revoke' | 'grant'): string {
  const what = action === 'revoke' ? 'still live' : 'not granted'
  if (isWalletTimeout(e)) return `Seed Vault did not answer in time. Nothing was signed; the permission is ${what}.`
  if (isUserCancel(e)) return `Closed in Seed Vault. Nothing was signed; the permission is ${what}.`
  return `Seed Vault could not finish. Nothing was signed; the permission is ${what}.`
}

/** A failure inside Seed Vault, before anything reached the chain. */
export class WalletStepError extends Error {
  readonly original: unknown
  constructor(original: unknown) {
    super(original instanceof Error ? original.message : String(original))
    this.original = original
  }
}

/**
 * What a revoke card says when the revoke did not finish. Server refusals are
 * already sentences; a wallet failure means nothing was sent; anything after
 * the signature means it may still land.
 */
export function revokeFailureText(e: unknown): string {
  if (e instanceof WalletStepError) return walletFailureText(e.original, 'revoke')
  if (e && typeof e === 'object' && 'code' in e && 'status' in e && e instanceof Error) return e.message
  return 'Sent to the chain but not confirmed yet. This card updates once the chain has it.'
}
