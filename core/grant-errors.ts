/**
 * Seed Vault could not submit the grant because its blockhash died while the
 * sheet was open (device check 4, 30 Sep: about a minute of reading). Nothing
 * was signed onto the chain, so the same permission can be rebuilt with a fresh
 * blockhash. MWA reports ERROR_NOT_SUBMITTED (-4); the wallet's text varies, so
 * the words are matched too.
 */
export function isBlockhashExpired(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null
  const code = e && typeof e === 'object' ? e.code : undefined
  if (code === -4 || code === '-4' || code === 'ERROR_NOT_SUBMITTED') return true
  const message = String(e && typeof e === 'object' ? (e.message ?? '') : (error ?? ''))
  return /blockhash|block height exceeded|transaction (has )?expired|not submitted/i.test(message)
}
