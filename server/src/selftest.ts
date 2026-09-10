/**
 * Test signer for /api/siws-verify. Acts as a stand-in wallet: generates an ephemeral
 * ed25519 keypair, builds the SIWS message for an issued payload exactly as a wallet
 * would (via the same @solana/wallet-standard-util message format the server verifies
 * against), signs it, and prints the request body for curl.
 *
 *   node dist/selftest.js sign <payload.json> [--domain <override>] > body.json
 *
 * <payload.json> is the response of GET /api/siws-payload (either the full response
 * or just its `payload` object). --domain signs the message under a different domain,
 * to prove domain binding is enforced. This is a client-side test tool only; it adds
 * no server surface.
 */
import { readFileSync } from 'node:fs'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createSignInMessageText } from '@solana/wallet-standard-util'
import bs58 from 'bs58'
import type { SiwsPayload } from './siws.js'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const [, , command, payloadFile, ...rest] = process.argv
if (command !== 'sign' || !payloadFile) {
  fail('usage: node dist/selftest.js sign <payload.json> [--domain <override>]')
}

const domainFlagIndex = rest.indexOf('--domain')
const domainOverride = domainFlagIndex >= 0 ? rest[domainFlagIndex + 1] : undefined
if (domainFlagIndex >= 0 && !domainOverride) fail('--domain needs a value')

const raw = JSON.parse(readFileSync(payloadFile, 'utf8')) as { payload?: SiwsPayload } & SiwsPayload
const payload: SiwsPayload = raw.payload ?? raw
if (!payload.nonce || !payload.domain) fail(`${payloadFile} does not look like a siws-payload response`)

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const jwk = publicKey.export({ format: 'jwk' })
if (typeof jwk.x !== 'string') fail('could not export raw public key')
const publicKeyBytes = Buffer.from(jwk.x, 'base64url')
const address = bs58.encode(publicKeyBytes)

const messageText = createSignInMessageText({
  ...payload,
  domain: domainOverride ?? payload.domain,
  address,
})
const messageBytes = Buffer.from(messageText, 'utf8')
const signature = sign(null, messageBytes, privateKey)

const body = {
  nonce: payload.nonce,
  signInResult: {
    address: publicKeyBytes.toString('base64'),
    signed_message: messageBytes.toString('base64'),
    signature: signature.toString('base64'),
  },
}
console.log(JSON.stringify(body))
