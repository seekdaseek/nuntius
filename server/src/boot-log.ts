import type { Config } from './config.js'

/**
 * What the server prints when it starts. The delegation spike's settings are
 * printed only when the spike routes are on: with SPIKE_ROUTES=0 a line such
 * as "delegation · cluster devnet · mint (devnet mints its own)…" right after
 * "mandates_enabled cluster mainnet" only alarms whoever reads the log
 * (deploy, 1 Oct).
 */
export function bootLines(
  config: Pick<Config, 'port' | 'domain' | 'heliusRpc' | 'delegation'>,
  o: { fcm: boolean; spike: boolean },
): string[] {
  const lines = [
    `nuntius server on 127.0.0.1:${config.port} · domain ${config.domain} · helius ${config.heliusRpc ? 'configured' : 'NOT configured'} · fcm ${o.fcm ? 'configured' : 'NOT configured'}`,
  ]
  if (o.spike) {
    // Printed, not assumed: on mainnet these four numbers are the difference
    // between a capped test and an uncapped one.
    const d = config.delegation
    lines.push(
      `delegation spike · cluster ${d.cluster} · mint ${d.mint ?? '(devnet mints its own)'} · cap ${d.capBaseUnits} base units · period ${d.periodLengthS}s · decimals ${d.decimals} · receiver ${d.receiverAta ?? "(delegatee's own ATA, created on first pull)"}`,
    )
  }
  return lines
}
