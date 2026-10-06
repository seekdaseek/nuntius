/**
 * The market numbers the backing page shows after the ones only nuntius has: the token's price
 * in its quote token, from the pool's own sqrt price (the curve's, or the migrated DAMM v2
 * pool's), and the quote token's USD price from Jupiter's price API, cached a minute. A read
 * that fails gives null and the page leaves the number out.
 */
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import * as CPAMM from '@meteora-ag/cp-amm-sdk'
import type { readLaunch } from './meteora.js'

type Launch = Awaited<ReturnType<typeof readLaunch>>

/** Quote tokens per whole launch token, or null when the pool's state was not read. */
export function priceInQuote(L: Launch, quoteDecimals: number): number | null {
  try {
    const dbc = L.raw.dbc?.pool as unknown as { poolState?: { sqrtPrice?: { toString(): string } } } | undefined
    if (L.route === 'dbc' && dbc?.poolState?.sqrtPrice) {
      const p = DBC.getPriceFromSqrtPrice(
        dbc.poolState.sqrtPrice as never,
        L.baseDecimals as never,
        quoteDecimals as never,
      )
      return Number(p.toString())
    }
    const a = L.raw.damm
    if (L.route === 'damm_v2' && a) {
      const baseIsA = a.tokenAMint.toBase58() === L.baseMint
      const p = Number(
        CPAMM.getPriceFromSqrtPrice(
          a.sqrtPrice,
          baseIsA ? L.baseDecimals : quoteDecimals,
          baseIsA ? quoteDecimals : L.baseDecimals,
        ).toString(),
      )
      return baseIsA ? p : p > 0 ? 1 / p : null
    }
  } catch {
    /* no price rather than a wrong one */
  }
  return null
}

const PRICE_URL = 'https://lite-api.jup.ag/price/v3?ids='
const TTL_MS = 60_000

/** USD prices of this server's quote tokens, from Jupiter, at most one request a minute per mint. */
export class UsdPrices {
  private readonly cache = new Map<string, { at: number; usd: number | null }>()
  constructor(
    private readonly doFetch: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async of(mint: string): Promise<number | null> {
    const c = this.cache.get(mint)
    if (c && this.now() - c.at < TTL_MS) return c.usd
    let usd: number | null = null
    try {
      const r = await this.doFetch(PRICE_URL + mint, { signal: AbortSignal.timeout(3_000) })
      const j = (await r.json()) as Record<string, { usdPrice?: unknown } | undefined>
      const v = j[mint]?.usdPrice
      usd = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
    } catch {
      usd = null
    }
    this.cache.set(mint, { at: this.now(), usd })
    return usd
  }
}
