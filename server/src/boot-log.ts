import type { Config } from './config.js'

/** What the server prints when it starts. */
export function bootLines(config: Pick<Config, 'port' | 'domain' | 'heliusRpc'>, o: { fcm: boolean }): string[] {
  return [
    `nuntius server on 127.0.0.1:${config.port} · domain ${config.domain} · helius ${config.heliusRpc ? 'configured' : 'NOT configured'} · fcm ${o.fcm ? 'configured' : 'NOT configured'}`,
  ]
}
