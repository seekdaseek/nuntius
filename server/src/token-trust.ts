/**
 * What a launch token's own accounts promise, read from the chain on every request: no one can
 * mint more, no one can freeze a holder's account, and its on-chain metadata (name, symbol and
 * URI) can never change. The JSON at the URI is served off chain, so the image is not part of
 * that promise. The backing page shows a badge for each promise that holds.
 *
 * A read that fails, or an account in a shape this does not know, gives null for that fact:
 * the page shows nothing rather than a guess.
 */
import { PublicKey } from '@solana/web3.js'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import type { MeteoraConnection } from './meteora.js'

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PeEELsHWPLbEnCeoq',
])
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
/** An update authority no one can sign for. */
const NO_ONE = '11111111111111111111111111111111'

export interface TokenTrust {
  mint: string
  /** The Metaplex metadata account, for the link; null when there is none. */
  metadata: string | null
  /** null: not read. */
  mintAuthorityDisabled: boolean | null
  freezeAuthorityDisabled: boolean | null
  /** Update authority no one, or the metadata marked immutable. */
  metadataPermanent: boolean | null
}

/** An SPL mint's authorities: COption<Pubkey> at 0 (mint) and at 46 (freeze). */
export function mintAuthorities(
  data: Uint8Array,
): { mintAuthority: string | null; freezeAuthority: string | null } | null {
  const b = Buffer.from(data)
  if (b.length < 82) return null
  const option = (at: number) => {
    const tag = b.readUInt32LE(at)
    if (tag === 0) return null
    if (tag !== 1) throw new Error('bad option tag')
    return new PublicKey(b.subarray(at + 4, at + 36)).toBase58()
  }
  try {
    return { mintAuthority: option(0), freezeAuthority: option(46) }
  } catch {
    return null
  }
}

/**
 * Metaplex metadata: key(1) update_authority(32) mint(32) name symbol uri (u32-prefixed strings)
 * seller_fee_basis_points(2) creators(Option<Vec<34 bytes>>) primary_sale_happened(1) is_mutable(1).
 */
export function metadataMutability(data: Uint8Array): { updateAuthority: string; isMutable: boolean } | null {
  const b = Buffer.from(data)
  try {
    if (b[0] !== 4) return null // Key::MetadataV1
    const updateAuthority = new PublicKey(b.subarray(1, 33)).toBase58()
    let at = 65
    for (let i = 0; i < 3; i++) at += 4 + b.readUInt32LE(at)
    at += 2
    const hasCreators = b[at]
    at += 1
    if (hasCreators === 1) at += 4 + b.readUInt32LE(at) * 34
    else if (hasCreators !== 0) return null
    const isMutable = b[at + 1]
    if (isMutable !== 0 && isMutable !== 1) return null
    return { updateAuthority, isMutable: isMutable === 1 }
  } catch {
    return null
  }
}

/** The three promises for one mint, from one read of its two accounts. Never throws. */
export async function readTokenTrust(conn: MeteoraConnection, mint: string): Promise<TokenTrust> {
  const empty: TokenTrust = {
    mint,
    metadata: null,
    mintAuthorityDisabled: null,
    freezeAuthorityDisabled: null,
    metadataPermanent: null,
  }
  let metadata: PublicKey
  try {
    metadata = DBC.deriveMintMetadata(new PublicKey(mint))
  } catch {
    return empty
  }
  const accounts = await conn.getMultipleAccountsInfo([new PublicKey(mint), metadata]).catch(() => null)
  if (!accounts) return empty
  const [m, md] = accounts
  const auth = m && TOKEN_PROGRAMS.has(m.owner.toBase58()) ? mintAuthorities(m.data) : null
  const meta = md && md.owner.toBase58() === METAPLEX ? metadataMutability(md.data) : null
  return {
    mint,
    metadata: md ? metadata.toBase58() : null,
    mintAuthorityDisabled: auth ? auth.mintAuthority === null : null,
    freezeAuthorityDisabled: auth ? auth.freezeAuthority === null : null,
    metadataPermanent: meta ? meta.updateAuthority === NO_ONE || !meta.isMutable : null,
  }
}
