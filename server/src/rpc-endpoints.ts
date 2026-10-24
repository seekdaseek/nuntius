/**
 * Every JSON-RPC call the server makes goes through here, for the kit Rpc (executor, guard,
 * routes), the web3.js connections (Meteora SDKs: buys, the crank, the launch routes), the
 * getProgramAccountsV2 pager and the app's /api/rpc proxy. One place:
 *
 * - counts calls per method, logged as one `rpc_usage` line every 10 minutes. The Helius free
 *   plan's 1,000,000 credits ran out on 23 Oct; this is how the burn is read from now on;
 * - moves a call to the next endpoint (RPC_FALLBACKS, by default the free public mainnet RPC)
 *   when the primary answers 429, 402, 403 or 5xx, or the connection drops. The primary is
 *   then left alone for 10 minutes and probed again.
 *
 * Endpoints are logged by host only: a Helius URL carries its key in the query.
 */
import {
  createDefaultRpcTransport,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type RpcTransport,
} from '@solana/kit'
import type { Logger } from './log.js'
import { isHelius } from './program-accounts.js'

/** Free, no account, 100 requests per 10 s per IP (Solana Foundation, Oct 2026). */
export const PUBLIC_MAINNET_RPC = 'https://api.mainnet-beta.solana.com'
export const FALLBACK_STAY_MS = 10 * 60_000
export const USAGE_EVERY_MS = 10 * 60_000

/** Methods only Helius answers: never sent to a fallback (their callers have a plain path). */
const HELIUS_ONLY = new Set(['getProgramAccountsV2', 'getTokenAccountsByOwnerV2'])

/** An answer that moves the call to the next endpoint: rate limited, out of credits, refused, or down. */
export function failsOver(status: number): boolean {
  return status === 429 || status === 402 || status === 403 || status >= 500
}

/** RPC_FALLBACKS: a comma list of https URLs. Unset means the public mainnet RPC; empty means none. */
export function parseFallbacks(raw: string | undefined): string[] {
  if (raw === undefined) return [PUBLIC_MAINNET_RPC]
  const urls = raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  for (const u of urls) {
    let ok = false
    try {
      ok = new URL(u).protocol === 'https:'
    } catch {
      ok = false
    }
    if (!ok) throw new Error('RPC_FALLBACKS: every entry must be an https URL')
  }
  return urls
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}

/** The JSON-RPC methods in a request body (one, or several for a batch). */
function methodsOf(payload: unknown): string[] {
  const one = (p: unknown) =>
    typeof p === 'object' && p !== null && typeof (p as { method?: unknown }).method === 'string'
      ? (p as { method: string }).method
      : 'unknown'
  return Array.isArray(payload) ? payload.map(one) : [one(payload)]
}

function methodsOfBody(body: unknown): string[] {
  if (typeof body !== 'string') return ['unknown']
  try {
    return methodsOf(JSON.parse(body))
  } catch {
    return ['unknown']
  }
}

/** The HTTP status kit's transport threw with, or null for anything else. */
function kitStatus(e: unknown): number | null {
  if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return Number(e.context.statusCode)
  return null
}

/** A connection that dropped or never opened: no answer at all. */
function dropped(e: unknown): boolean {
  const m = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e)
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network/i.test(m)
}

export class RpcEndpoints {
  private readonly urls: string[]
  private readonly now: () => number
  private readonly stayMs: number
  private readonly doFetch: typeof fetch
  private primaryDownUntil = 0
  private primaryDown = false
  private calls = new Map<string, number>()
  private hosts = new Map<string, number>()
  private failovers = 0
  private transportOf = new Map<string, RpcTransport>()

  constructor(
    primary: string,
    fallbacks: string[],
    private readonly o: { now?: () => number; stayMs?: number; log?: Logger; fetch?: typeof fetch } = {},
  ) {
    this.urls = [primary, ...fallbacks.filter((u) => u !== primary)]
    this.now = o.now ?? Date.now
    this.stayMs = o.stayMs ?? FALLBACK_STAY_MS
    this.doFetch = o.fetch ?? fetch
  }

  get primary(): string {
    return this.urls[0]!
  }

  /** Whether calls go to the primary first right now. */
  primaryUp(): boolean {
    return this.now() >= this.primaryDownUntil
  }

  /** The order to try right now: the primary first, unless it failed within the last stayMs. */
  order(): string[] {
    const [p, ...rest] = this.urls
    return this.primaryUp() ? this.urls : [...rest, p!]
  }

  private count(methods: string[], url: string): void {
    for (const m of methods) this.calls.set(m, (this.calls.get(m) ?? 0) + 1)
    const h = hostOf(url)
    this.hosts.set(h, (this.hosts.get(h) ?? 0) + methods.length)
  }

  private failed(url: string, why: number | 'dropped'): void {
    if (url !== this.primary) return
    this.primaryDownUntil = this.now() + this.stayMs
    if (!this.primaryDown) {
      this.primaryDown = true
      this.failovers++
      this.o.log?.warn('rpc_failover', {
        from: hostOf(url),
        to: hostOf(this.urls[1] ?? url),
        why: String(why),
        forS: Math.round(this.stayMs / 1000),
      })
    }
  }

  private answered(url: string): void {
    if (url === this.primary && this.primaryDown) {
      this.primaryDown = false
      this.o.log?.info('rpc_primary_back', { host: hostOf(url) })
    }
  }

  /**
   * A fetch for JSON-RPC POSTs (web3.js Connection's `fetch`, the V2 pager, the /api/rpc
   * proxy). The URL it is called with is ignored: the endpoints decide.
   */
  readonly fetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const methods = methodsOfBody(init?.body)
    const heliusOnly = methods.some((m) => HELIUS_ONLY.has(m))
    const order = this.order().filter((u) => !heliusOnly || isHelius(u))
    if (order.length === 0) throw new Error(`${methods.join(',')}: no endpoint answers this method`)
    let lastError: unknown
    for (const [i, url] of order.entries()) {
      const last = i === order.length - 1
      this.count(methods, url)
      try {
        const res = await this.doFetch(url, init)
        if (!last && failsOver(res.status)) {
          this.failed(url, res.status)
          void res.body?.cancel().catch(() => {})
          continue
        }
        if (failsOver(res.status)) this.failed(url, res.status)
        else this.answered(url)
        return res
      } catch (e) {
        lastError = e
        if (!dropped(e)) throw e
        this.failed(url, 'dropped')
        if (last) throw e
      }
    }
    throw lastError
  }

  /** The kit transport: one default transport per endpoint, tried in order. */
  transport(): RpcTransport {
    for (const url of this.urls)
      if (!this.transportOf.has(url)) this.transportOf.set(url, createDefaultRpcTransport({ url }))
    return (async (config: Parameters<RpcTransport>[0]) => {
      const methods = methodsOf(config.payload)
      const order = this.order()
      let lastError: unknown
      for (const [i, url] of order.entries()) {
        const last = i === order.length - 1
        this.count(methods, url)
        try {
          const out = await this.transportOf.get(url)!(config)
          this.answered(url)
          return out
        } catch (e) {
          lastError = e
          const status = kitStatus(e)
          const moves = status !== null ? failsOver(status) : dropped(e)
          if (!moves) throw e
          this.failed(url, status ?? 'dropped')
          if (last) throw e
        }
      }
      throw lastError
    }) as RpcTransport
  }

  /** The calls since the last read, per method and per endpoint host, and resets them. */
  takeUsage(): { calls: Record<string, number>; hosts: Record<string, number>; total: number; failovers: number } {
    const calls = Object.fromEntries([...this.calls].sort((a, b) => b[1] - a[1]))
    const hosts = Object.fromEntries(this.hosts)
    const total = [...this.calls.values()].reduce((s, n) => s + n, 0)
    const failovers = this.failovers
    this.calls = new Map()
    this.hosts = new Map()
    this.failovers = 0
    return { calls, hosts, total, failovers }
  }

  /** One `rpc_usage` line every `everyMs`: calls per method, per host, and whether on the fallback. */
  startUsageLog(log: Logger, everyMs = USAGE_EVERY_MS): () => void {
    const handle = setInterval(() => {
      const u = this.takeUsage()
      log.info('rpc_usage', {
        windowS: Math.round(everyMs / 1000),
        total: u.total,
        ...u.calls,
        ...Object.fromEntries(Object.entries(u.hosts).map(([h, n]) => [`host:${h}`, n])),
        failovers: u.failovers,
        onFallback: !this.primaryUp(),
      })
    }, everyMs)
    handle.unref?.()
    return () => clearInterval(handle)
  }
}
