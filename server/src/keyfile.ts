/**
 * Reading secret files without leaking them. On Node 22 a JSON.parse SyntaxError quotes
 * part of its input (Unexpected token 'x', ..."9,238,135,x]" is not valid JSON), so the
 * error from parsing a malformed keypair file carries key bytes. Nothing here lets the
 * parser's or the reader's error text escape: every failure is a fixed message naming
 * what failed, never the file's content.
 */
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit'

export class SecretFileError extends Error {
  constructor(
    what: string,
    readonly reason: 'unreadable' | 'malformed',
  ) {
    super(`${what}: ${reason === 'unreadable' ? 'the file could not be read' : 'the file is not a valid key file'}`)
    this.name = 'SecretFileError'
  }
}

/** A Solana CLI keypair file (a JSON array of 64 bytes) as a signer. */
export async function keypairFromFile(path: string, what: string): Promise<KeyPairSigner> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new SecretFileError(what, 'unreadable')
  }
  try {
    const bytes: unknown = JSON.parse(text)
    if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
      throw new Error()
    return await createKeyPairSignerFromBytes(new Uint8Array(bytes as number[]))
  } catch {
    throw new SecretFileError(what, 'malformed')
  }
}

/** A JSON secret file (the FCM service account), parsed; failures say only what failed. */
export function jsonSecretFromFile(path: string, what: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new SecretFileError(what, 'unreadable')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new SecretFileError(what, 'malformed')
  }
}
