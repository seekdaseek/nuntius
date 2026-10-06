/**
 * A launch token's image, read from its metadata: the Metaplex account's URI, the JSON at that
 * URI, its `image`. For the header of the web backing page.
 *
 * A URI on this server's own origin is read here, not fetched: /m/<mint>.json from the launch
 * it was created with, /t/<file>.json from static/tokens. Any other URI is fetched only over
 * https on port 443, from a host whose every address is public, with no redirects, within 3 s
 * and 64 KB. Only an https image is passed on (one on this origin as a path), and the visitor's
 * browser loads it; the server never fetches the image itself. Cached per mint.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList } from 'node:net'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PublicKey } from '@solana/web3.js'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import type { MeteoraConnection } from './meteora.js'

const IMAGE_RE = /^https:\/\/[^\s"'<>\\]{1,300}$/
const TOKEN_JSON_RE = /^[a-z0-9][a-z0-9-]{0,40}\.json$/
const MAX_BYTES = 64 * 1024
const HIT_MS = 60 * 60_000
const MISS_MS = 10 * 60_000
const MAX_ENTRIES = 500

/** The URI in a Metaplex metadata account: key(1) update_authority(32) mint(32) name symbol uri. */
export function uriFromMetadata(data: Uint8Array): string | null {
  const b = Buffer.from(data)
  try {
    let at = 65
    for (let i = 0; i < 2; i++) at += 4 + b.readUInt32LE(at) // name, symbol
    const len = b.readUInt32LE(at)
    if (len > 400 || at + 4 + len > b.length) return null
    const uri = b
      .subarray(at + 4, at + 4 + len)
      .toString('utf8')
      .replace(/\0/g, '')
      .trim()
    return uri || null
  } catch {
    return null
  }
}

// Two lists: Node's BlockList matches an IPv4 address against IPv4-mapped IPv6 rules too.
const PRIVATE_V4 = new BlockList()
const PRIVATE_V6 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  PRIVATE_V4.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE_V6.addSubnet(net, bits, 'ipv6')

/**
 * True when the address is not loopback, private, link-local, shared, reserved or multicast.
 * An IPv4-mapped IPv6 answer is never public: a public host has no reason to give one.
 */
export function isPublicAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) return !PRIVATE_V4.check(address, 'ipv4')
  if (/^::ffff:/i.test(address)) return false
  return !PRIVATE_V6.check(address, 'ipv6')
}

export interface TokenImageDeps {
  /** https://<domain>, the origin /m/ and /t/ are served from. */
  origin: string
  /** The launch nuntius created for this mint, if any (its stored image). */
  launchImage: (mint: string) => string | null
  tokensDir: string
  readUri: (mint: string) => Promise<string | null>
  lookup?: (host: string) => Promise<{ address: string; family: 4 | 6 }[]>
  fetch?: typeof fetch
  now?: () => number
}

export class TokenImages {
  private readonly cache = new Map<string, { at: number; image: string | null }>()
  private readonly pending = new Map<string, Promise<string | null>>()
  private readonly lookup: NonNullable<TokenImageDeps['lookup']>
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly d: TokenImageDeps) {
    this.lookup =
      d.lookup ??
      (async (host) =>
        (await dnsLookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family as 4 | 6 })))
    this.fetch = d.fetch ?? fetch
    this.now = d.now ?? Date.now
  }

  /** The image to show for this mint: a path on this origin, an https URL, or null. Never throws. */
  async imageOf(mint: string): Promise<string | null> {
    const c = this.cache.get(mint)
    if (c && this.now() - c.at < (c.image ? HIT_MS : MISS_MS)) return c.image
    let p = this.pending.get(mint)
    if (!p) {
      p = this.read(mint)
        .catch(() => null)
        .then((image) => {
          this.pending.delete(mint)
          if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!)
          this.cache.set(mint, { at: this.now(), image })
          return image
        })
      this.pending.set(mint, p)
    }
    return p
  }

  private async read(mint: string): Promise<string | null> {
    const uri = await this.d.readUri(mint)
    if (!uri) return null
    const json = await this.metadataJson(uri)
    const image = json && typeof json.image === 'string' ? json.image.trim() : ''
    if (!IMAGE_RE.test(image)) return null
    const own = `${this.d.origin}/`
    return image.startsWith(own) ? image.slice(this.d.origin.length) : image
  }

  private async metadataJson(uri: string): Promise<Record<string, unknown> | null> {
    const own = `${this.d.origin}/`
    if (uri.startsWith(own)) {
      const rest = uri.slice(own.length)
      const m = /^m\/([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(rest)
      if (m) {
        const image = this.d.launchImage(m[1]!)
        return image ? { image } : null
      }
      const t = /^t\/(.+)$/.exec(rest)
      if (t && TOKEN_JSON_RE.test(t[1]!))
        return JSON.parse(await readFile(path.join(this.d.tokensDir, t[1]!), 'utf8')) as Record<string, unknown>
      return null
    }
    return this.publicJson(uri)
  }

  /** GET a JSON document from a public https host, within the limits above; null otherwise. */
  private async publicJson(uri: string): Promise<Record<string, unknown> | null> {
    let url: URL
    try {
      url = new URL(uri)
    } catch {
      return null
    }
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host.endsWith('.localhost')) return null
    const addresses = await this.lookup(host)
    if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address, a.family))) return null
    const res = await this.fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3_000),
      headers: { accept: 'application/json' },
    })
    if (res.status !== 200 || !res.body) return null
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const j = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null
  }
}

/** The metadata URI of a mint, from its Metaplex account; null when there is none. */
export async function readMetadataUri(conn: MeteoraConnection, mint: string): Promise<string | null> {
  const md = await conn.getAccountInfo(DBC.deriveMintMetadata(new PublicKey(mint)))
  return md ? uriFromMetadata(md.data) : null
}
