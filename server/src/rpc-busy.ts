import type express from 'express'

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

/**
 * What a route answers when the chain or a service behind it failed. Behind the Cloudflare
 * tunnel an origin 502 or 504 reaches the client as Cloudflare's text "error code: 502" (24 Oct:
 * the app read it as "JSON Parse error: Unexpected character: e"), while a 503 or 424 keeps its
 * JSON body (measured on nuntius.ochinimus.app). So: a busy RPC is 503 chain_busy, with a
 * Retry-After; any other upstream failure is 424.
 */
export function upstreamFailure(e: unknown, code: string): { status: 503 | 424; error: string; retryAfterS?: number } {
  const m = /rpc http (\d{3})/.exec(e instanceof Error ? e.message : '')
  const status = m ? Number(m[1]) : null
  const busy =
    transientRpcError(e) || (status !== null && (status === 429 || status === 402 || status === 403 || status >= 500))
  return busy ? { status: 503, error: 'chain_busy', retryAfterS: BUSY_RETRY_AFTER_S } : { status: 424, error: code }
}

/** 503 chain_busy with a Retry-After: the RPC was busy, which says nothing about what was asked. */
export function sendChainBusy(res: express.Response): void {
  res.setHeader('Retry-After', String(BUSY_RETRY_AFTER_S))
  res
    .status(503)
    .json({ ok: false, error: 'chain_busy', message: 'The Solana network is busy. Try again in a few seconds.' })
}

/** A route's answer to a failure upstream of it, as JSON that Cloudflare passes through (upstreamFailure). */
export function sendUpstreamFailure(res: express.Response, e: unknown, code: string, message?: string): void {
  const f = upstreamFailure(e, code)
  if (f.status === 503) return sendChainBusy(res)
  res.status(424).json({ ok: false, error: f.error, ...(message ? { message } : {}) })
}
