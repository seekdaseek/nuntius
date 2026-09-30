/**
 * Small in-memory rate limits for the routes that cost something: the RPC proxy
 * (Helius credits), SIWS issuance and verification, and the demo over-cap pull
 * (every call spends the delegatee's SOL).
 *
 * Fixed windows per key. The key is the client IP: behind the Cloudflare tunnel
 * every request arrives from loopback, so for a loopback socket the real client
 * is taken from `CF-Connecting-IP`; for any other socket that header is ignored,
 * because a direct caller could set it to anything.
 *
 * In-memory is deliberate: one process, one VPS. A restart forgets the counters,
 * which only ever errs toward letting a request through.
 */
import type express from 'express'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const IP_RE = /^[0-9a-fA-F:.]{2,45}$/

export function clientIp(req: Pick<express.Request, 'socket' | 'headers'>): string {
  const socket = req.socket.remoteAddress ?? 'unknown'
  if (LOOPBACK.has(socket)) {
    const cf = req.headers['cf-connecting-ip']
    if (typeof cf === 'string' && IP_RE.test(cf.trim())) return cf.trim()
  }
  return socket
}

export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>()

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit; returns seconds to wait when over the limit, else 0. */
  take(key: string): number {
    const t = this.now()
    const cur = this.hits.get(key)
    if (!cur || t - cur.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 })
      if (this.hits.size > 10_000) this.sweep(t)
      return 0
    }
    if (cur.count >= this.max) return Math.ceil((cur.windowStart + this.windowMs - t) / 1000)
    cur.count++
    return 0
  }

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(k)
  }
}

/** "Too many tries. Try again in 2 minutes.": a sentence the app shows as is. */
export function retryMessage(retryAfterS: number): string {
  const minutes = retryAfterS >= 60
  const n = minutes ? Math.ceil(retryAfterS / 60) : retryAfterS
  return `Too many tries. Try again in ${n} ${minutes ? 'minute' : 'second'}${n === 1 ? '' : 's'}.`
}

export function tooMany(res: express.Response, retryAfterS: number): void {
  res.setHeader('Retry-After', String(retryAfterS))
  res.status(429).json({ ok: false, error: 'rate_limited', message: retryMessage(retryAfterS), retryAfterS })
}

/** Express middleware: one limiter, keyed on the client IP. */
export function limitByIp(limiter: RateLimiter): express.RequestHandler {
  return (req, res, next) => {
    const wait = limiter.take(clientIp(req))
    if (wait > 0) return tooMany(res, wait)
    next()
  }
}

export interface Limits {
  rpc: RateLimiter
  siwsPayload: RateLimiter
  siwsVerify: RateLimiter
  demoPerIp: RateLimiter
  demoPerMandate: RateLimiter
}

/** Production defaults. Tests pass their own. */
export function defaultLimits(): Limits {
  return {
    rpc: new RateLimiter(60, 60_000),
    siwsPayload: new RateLimiter(20, 60_000),
    siwsVerify: new RateLimiter(20, 60_000),
    demoPerIp: new RateLimiter(10, 60 * 60_000),
    // Tight: one refusal every 2 minutes per mandate is plenty for a demo.
    demoPerMandate: new RateLimiter(1, 2 * 60_000),
  }
}
