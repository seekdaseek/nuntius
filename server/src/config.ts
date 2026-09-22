export interface Config {
  port: number
  domain: string
  heliusRpc: string | null
  fcmServiceAccount: string | null
  fcmProjectId: string | null
  delegation: DelegationConfig
}

/**
 * Delegation parameters. Mainnet moves real value, so the mint is never inferred
 * and the cap is never defaulted upward: both must be stated explicitly, and the
 * cap is the only thing standing between a bug and a user's balance.
 */
export interface DelegationConfig {
  cluster: 'devnet' | 'mainnet'
  /** Existing mint to delegate against. Required on mainnet; devnet mints its own. */
  mint: string | null
  decimals: number
  /** Base units the delegatee may pull per period. */
  capBaseUnits: bigint
  periodLengthS: bigint
  /**
   * Where pulled tokens land. When unset the delegatee's own ATA is created and
   * used, which costs rent. Naming an existing account avoids that — the program
   * places no ownership constraint on the receiver, it only records the owner in
   * the emitted event.
   */
  receiverAta: string | null
}

// Bare host, optionally with a port. This is the SIWS binding domain, not a URL.
const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/i

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const domain = env.NUNTIUS_DOMAIN ?? ''
  if (!DOMAIN_RE.test(domain)) {
    throw new Error('NUNTIUS_DOMAIN must be a bare host such as ochinimus.app')
  }

  const port = env.PORT === undefined || env.PORT === '' ? 8787 : Number(env.PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }

  const heliusRpc = env.HELIUS_RPC === undefined || env.HELIUS_RPC === '' ? null : env.HELIUS_RPC
  if (heliusRpc !== null && !heliusRpc.startsWith('https://')) {
    throw new Error('HELIUS_RPC must be an https URL')
  }

  // Both must be present for push; either alone is a config mistake worth failing on.
  const fcmServiceAccount =
    env.FCM_SERVICE_ACCOUNT === undefined || env.FCM_SERVICE_ACCOUNT === '' ? null : env.FCM_SERVICE_ACCOUNT
  const fcmProjectId = env.FCM_PROJECT_ID === undefined || env.FCM_PROJECT_ID === '' ? null : env.FCM_PROJECT_ID
  if ((fcmServiceAccount === null) !== (fcmProjectId === null)) {
    throw new Error('FCM_SERVICE_ACCOUNT and FCM_PROJECT_ID must be set together')
  }

  return { port, domain, heliusRpc, fcmServiceAccount, fcmProjectId, delegation: loadDelegationConfig(env) }
}

// Base58, 32-byte range. Enough to reject a typo before it reaches the chain.
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function loadDelegationConfig(env: NodeJS.ProcessEnv): DelegationConfig {
  const raw = env.DELEGATION_CLUSTER ?? 'devnet'
  if (raw !== 'devnet' && raw !== 'mainnet') {
    throw new Error("DELEGATION_CLUSTER must be 'devnet' or 'mainnet'")
  }
  const cluster = raw

  const mint = env.DELEGATION_MINT === undefined || env.DELEGATION_MINT === '' ? null : env.DELEGATION_MINT
  if (cluster === 'mainnet' && mint === null) {
    throw new Error('DELEGATION_MINT is required when DELEGATION_CLUSTER=mainnet')
  }
  if (mint !== null && !ADDRESS_RE.test(mint)) {
    throw new Error('DELEGATION_MINT must be a base58 address')
  }

  const decimals = env.DELEGATION_DECIMALS === undefined ? 6 : Number(env.DELEGATION_DECIMALS)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('DELEGATION_DECIMALS must be an integer between 0 and 18')
  }

  // Devnet keeps the spike's 100-token cap; mainnet has no safe default, so it
  // must be stated. A default here would be a default on someone's money.
  const capRaw = env.DELEGATION_CAP_BASE_UNITS
  if (cluster === 'mainnet' && (capRaw === undefined || capRaw === '')) {
    throw new Error('DELEGATION_CAP_BASE_UNITS is required when DELEGATION_CLUSTER=mainnet')
  }
  const capBaseUnits =
    capRaw === undefined || capRaw === ''
      ? 100n * 10n ** BigInt(decimals)
      : parseBigint(capRaw, 'DELEGATION_CAP_BASE_UNITS')
  if (capBaseUnits <= 0n) throw new Error('DELEGATION_CAP_BASE_UNITS must be greater than zero')

  const periodLengthS =
    env.DELEGATION_PERIOD_S === undefined || env.DELEGATION_PERIOD_S === ''
      ? 60n
      : parseBigint(env.DELEGATION_PERIOD_S, 'DELEGATION_PERIOD_S')
  // The program's own bounds: period_length_s must be > 0 and <= 365 days.
  if (periodLengthS <= 0n || periodLengthS > 31_536_000n) {
    throw new Error('DELEGATION_PERIOD_S must be between 1 and 31536000')
  }

  const receiverAta =
    env.DELEGATION_RECEIVER_ATA === undefined || env.DELEGATION_RECEIVER_ATA === '' ? null : env.DELEGATION_RECEIVER_ATA
  if (receiverAta !== null && !ADDRESS_RE.test(receiverAta)) {
    throw new Error('DELEGATION_RECEIVER_ATA must be a base58 address')
  }

  return { cluster, mint, decimals, capBaseUnits, periodLengthS, receiverAta }
}

function parseBigint(value: string, name: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number of base units`)
  return BigInt(value)
}
