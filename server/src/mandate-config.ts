/**
 * mandatum configuration. Mainnet moves real money, so nothing that bounds a
 * user's exposure has an implicit default that could be larger than intended:
 *
 * - MANDATE_CLUSTER       'mainnet' | 'localnet'. Absent = mandates disabled.
 * - MANDATE_RPC           RPC URL. Mainnet falls back to HELIUS_RPC; localnet must be loopback.
 * - MANDATE_MINTS         SYMBOL:mint:decimals[:maxPerPeriod][,…] the app offers.
 *                         Mainnet default: USDC and SKR (SKR ceiling 55).
 * - MANDATE_MAX_PER_PERIOD  beta ceiling for mints without their own, in UI units
 *                         (default 100). A second, server-side bound on top of the chain's.
 * - MANDATE_DELEGATEE     path to the executor keypair file (never committed).
 * - EXECUTOR_INTERVAL_MS  default 30000. GUARD_INTERVAL_MS default 60000.
 * - DEMO_ENDPOINTS        '1' enables the over-cap demo button. Off by default.
 */
export interface MintInfo {
  symbol: string
  mint: string
  decimals: number
  /** This mint's beta ceiling per period, UI units. Absent = MANDATE_MAX_PER_PERIOD. */
  maxPerPeriodUi?: string
}

export interface MandateConfig {
  cluster: 'mainnet' | 'localnet'
  rpcUrl: string
  mints: MintInfo[]
  maxPerPeriodUi: string
  delegateePath: string | null
  executorIntervalMs: number
  guardIntervalMs: number
  demoEndpoints: boolean
  /**
   * Subscription launches (Meteora back permissions and launches). Off unless
   * MANDATE_LAUNCHES=1: v1.0.1 keeps them hidden until the Meteora device run.
   */
  launches: boolean
  /**
   * The fixed nuntius partner config each launch is created on, by quote symbol
   * (LAUNCH_CONFIGS=SKR:<config>,USDC:<config>). One config per quote mint, created once;
   * a quote with none cannot be launched in.
   */
  launchConfigs: Record<string, string>
}

const USDC_MAINNET: MintInfo = { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }
/** Solana Mobile's SKR (SPL Token program, 6 decimals; read on mainnet 30 Sep 2026). */
export const SKR_MAINNET: MintInfo = {
  symbol: 'SKR',
  mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',
  decimals: 6,
  // About 1 USD of SKR at 0.0181 USD per SKR (read 30 Sep 2026): 55 x 0.0181 = 0.9955.
  maxPerPeriodUi: '55',
}
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function loadMandateConfig(env: NodeJS.ProcessEnv, heliusRpc: string | null): MandateConfig | null {
  const cluster = env.MANDATE_CLUSTER
  if (cluster === undefined || cluster === '') return null
  if (cluster !== 'mainnet' && cluster !== 'localnet')
    throw new Error("MANDATE_CLUSTER must be 'mainnet' or 'localnet'")

  const rpcUrl = env.MANDATE_RPC || (cluster === 'mainnet' ? heliusRpc : '') || ''
  if (!rpcUrl) throw new Error('MANDATE_RPC (or HELIUS_RPC on mainnet) is required')
  const host = new URL(rpcUrl).hostname
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(host)
  if (cluster === 'localnet' && !loopback) throw new Error('MANDATE_CLUSTER=localnet requires a loopback MANDATE_RPC')
  if (cluster === 'mainnet' && !rpcUrl.startsWith('https://')) throw new Error('mainnet MANDATE_RPC must be https')

  const mints = env.MANDATE_MINTS
    ? parseMints(env.MANDATE_MINTS)
    : cluster === 'mainnet'
      ? [USDC_MAINNET, SKR_MAINNET]
      : []
  if (mints.length === 0) throw new Error('MANDATE_MINTS is required on localnet')

  const maxPerPeriodUi = env.MANDATE_MAX_PER_PERIOD || '100'
  if (!/^\d+(\.\d+)?$/.test(maxPerPeriodUi)) throw new Error('MANDATE_MAX_PER_PERIOD must be a number')

  const int = (v: string | undefined, d: number, name: string) => {
    if (v === undefined || v === '') return d
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1000) throw new Error(`${name} must be an integer >= 1000`)
    return n
  }
  return {
    cluster,
    rpcUrl,
    mints,
    maxPerPeriodUi,
    delegateePath: env.MANDATE_DELEGATEE || null,
    executorIntervalMs: int(env.EXECUTOR_INTERVAL_MS, 30_000, 'EXECUTOR_INTERVAL_MS'),
    guardIntervalMs: int(env.GUARD_INTERVAL_MS, 60_000, 'GUARD_INTERVAL_MS'),
    demoEndpoints: env.DEMO_ENDPOINTS === '1',
    launches: env.MANDATE_LAUNCHES === '1',
    launchConfigs: parseLaunchConfigs(env.LAUNCH_CONFIGS ?? '', mints),
  }
}

export function parseLaunchConfigs(raw: string, mints: MintInfo[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [symbol, config, ...rest] = part.split(':')
    if (rest.length || !symbol || !config) throw new Error(`LAUNCH_CONFIGS: expected SYMBOL:config in "${part}"`)
    if (!mints.some((m) => m.symbol === symbol)) throw new Error(`LAUNCH_CONFIGS: ${symbol} is not an offered token`)
    if (!ADDRESS_RE.test(config)) throw new Error(`LAUNCH_CONFIGS: bad config address for ${symbol}`)
    out[symbol] = config
  }
  return out
}

export function parseMints(raw: string): MintInfo[] {
  return raw.split(',').map((part) => {
    const [symbol, mint, dec, max, ...rest] = part.trim().split(':')
    if (rest.length) throw new Error(`MANDATE_MINTS: too many fields in "${part}"`)
    const decimals = Number(dec)
    if (!symbol || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error(`MANDATE_MINTS: bad symbol in "${part}"`)
    if (!mint || !ADDRESS_RE.test(mint)) throw new Error(`MANDATE_MINTS: bad mint in "${part}"`)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
      throw new Error(`MANDATE_MINTS: bad decimals in "${part}"`)
    if (max !== undefined && !/^\d+(\.\d+)?$/.test(max)) throw new Error(`MANDATE_MINTS: bad ceiling in "${part}"`)
    return max === undefined ? { symbol, mint, decimals } : { symbol, mint, decimals, maxPerPeriodUi: max }
  })
}
