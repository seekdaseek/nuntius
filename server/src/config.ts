export interface Config {
  port: number
  domain: string
  heliusRpc: string | null
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

  return { port, domain, heliusRpc }
}
