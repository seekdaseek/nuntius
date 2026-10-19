/**
 * An RPC that is busy is not an answer. A rate limit (Helius 429s came in bursts of up to about
 * 40 minutes, 8 to 15 Oct), an overloaded node or a dropped connection says nothing about the
 * account that was asked for, so it must never read as "no such pool".
 */

/**
 * An RPC call that failed on the way, not an answer: a rate limit or an overloaded node (as
 * kit and web3.js word them), or a connection that dropped. Read again, it may well succeed.
 */
export function transientRpcError(e: unknown): boolean {
  if (e instanceof ChainBusy) return true
  const m = e instanceof Error ? e.message : String(e)
  return /\b429\b|too many requests|\b50[234]\b|overloaded|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
    m,
  )
}

/** The chain could not be read just now, after a few tries. Routes answer it with 503 chain_busy. */
export class ChainBusy extends Error {
  constructor(readonly cause: unknown) {
    super(`the Solana RPC is busy (${cause instanceof Error ? cause.message : String(cause)})`)
  }
}

/** The waits between tries of one read: three tries in about a second. */
export const BUSY_RETRY_MS: readonly number[] = [250, 750]

/** How long a client is told to wait before asking again (Retry-After, seconds). */
export const BUSY_RETRY_AFTER_S = 5

/**
 * One read, tried again after a short wait while the RPC is busy, then ChainBusy. Any other
 * error is thrown at once: it is the chain's answer, or a bug.
 */
export async function busyRetry<T>(read: () => Promise<T>, waitsMs: readonly number[] = BUSY_RETRY_MS): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await read()
    } catch (e) {
      if (!transientRpcError(e)) throw e
      if (i >= waitsMs.length) throw e instanceof ChainBusy ? e : new ChainBusy(e)
      await new Promise((r) => setTimeout(r, waitsMs[i]))
    }
  }
}
