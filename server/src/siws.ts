import { randomBytes } from 'node:crypto'
import { verifySignIn } from '@solana/wallet-standard-util'
import type { SolanaSignInInput, SolanaSignInOutput } from '@solana/wallet-standard-features'
import bs58 from 'bs58'

/** Nonce lifetime. The brief caps expiry at 10 minutes; 5 keeps it comfortably short-lived. */
export const NONCE_TTL_MS = 5 * 60 * 1000

/** The SIWS input this server issues. Stored server-side keyed by nonce; never trusted from the client. */
export interface SiwsPayload {
  domain: string
  uri: string
  statement: string
  nonce: string
  issuedAt: string
  expirationTime: string
}

export function buildPayload(domain: string, nowMs: number): SiwsPayload {
  return {
    domain,
    uri: `https://${domain}`,
    statement: 'Sign in to nuntius',
    nonce: randomBytes(16).toString('hex'),
    issuedAt: new Date(nowMs).toISOString(),
    expirationTime: new Date(nowMs + NONCE_TTL_MS).toISOString(),
  }
}

export const NONCE_RE = /^[0-9a-f]{32}$/

/** Decoded MWA sign_in_result: base64 address (32-byte ed25519 key), signed_message, signature. */
export interface ParsedSignInResult {
  publicKey: Uint8Array
  signedMessage: Uint8Array
  signature: Uint8Array
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

function decodeBase64(value: unknown, minBytes: number, maxBytes: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes * 2) return null
  if (!BASE64_RE.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length < minBytes || bytes.length > maxBytes) return null
  return new Uint8Array(bytes)
}

/**
 * Shape-validate before anything touches the nonce store. A wallet without SIWS support
 * omits sign_in_result entirely; a malformed request must not burn a valid nonce.
 */
export function parseSignInResult(value: unknown): ParsedSignInResult | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const publicKey = decodeBase64(v.address, 32, 32)
  const signedMessage = decodeBase64(v.signed_message, 1, 4096)
  const signature = decodeBase64(v.signature, 64, 64)
  if (!publicKey || !signedMessage || !signature) return null
  return { publicKey, signedMessage, signature }
}

export type SiwsVerifyError = 'signature_invalid' | 'domain_mismatch'
export type SiwsVerifyResult = { ok: true; address: string } | { ok: false; error: SiwsVerifyError }

const MESSAGE_DOMAIN_RE = /^([^\n]+?) wants you to sign in with your Solana account:\n/

/**
 * Verifies a sign_in_result against the server-issued payload. The caller has already
 * consumed the nonce atomically; this checks the signature, then the domain binding.
 */
export function verifySiws(payload: SiwsPayload, expectedDomain: string, result: ParsedSignInResult): SiwsVerifyResult {
  const address = bs58.encode(result.publicKey)

  // input.address ties the address line inside the signed message to the very key the
  // signature is checked against — without it, verifySignIn never binds the two.
  const input: SolanaSignInInput = {
    domain: payload.domain,
    address,
    statement: payload.statement,
    uri: payload.uri,
    nonce: payload.nonce,
    issuedAt: payload.issuedAt,
    expirationTime: payload.expirationTime,
  }
  const output = {
    account: { address, publicKey: result.publicKey, chains: [], features: [] },
    signature: result.signature,
    signedMessage: result.signedMessage,
  } as unknown as SolanaSignInOutput

  if (!verifySignIn(input, output)) {
    return { ok: false, error: 'signature_invalid' }
  }

  // Independent domain binding: both the stored payload and the signed message itself
  // must carry this server's domain. A signature minted for another dApp dies here.
  const messageDomain = MESSAGE_DOMAIN_RE.exec(new TextDecoder().decode(result.signedMessage))?.[1] ?? null
  if (payload.domain !== expectedDomain || messageDomain !== expectedDomain) {
    return { ok: false, error: 'domain_mismatch' }
  }

  return { ok: true, address }
}
