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

/**
 * After a wallet error: did the grant land anyway? A wallet can answer with an
 * error after it sent the transaction (device round 6, 5 Oct 2026: the grant
 * landed 1 s after the Seed Vault signature, the wallet held its sheet 84 s and
 * then reported a failure). So when the server built a grant and the app's own
 * check let it through, the app asks the server before saying "not granted";
 * the server activates only on an exact on-chain match. `confirm` resolves
 * when it is live; `isPending` tells "not on chain yet" from a real refusal.
 * A user's cancel is asked once, any other error a few times. Returns null
 * when it did not land (or could not have).
 */
export async function landedAnyway<T>(
  error: unknown,
  built: boolean,
  confirm: () => Promise<T>,
  isPending: (e: unknown) => boolean,
  { cancelled = false, tries = 3, delayMs = 1_500 }: { cancelled?: boolean; tries?: number; delayMs?: number } = {},
): Promise<T | null> {
  // Nothing built, or refused by the app's check (core/tx-check.ts): nothing reached Seed Vault.
  if (!built || (error instanceof Error && error.name === 'TxMismatch')) return null
  const n = cancelled ? 1 : tries
  for (let i = 0; i < n; i++) {
    try {
      return await confirm()
    } catch (e) {
      if (!isPending(e)) return null
      if (i < n - 1) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  return null
}
