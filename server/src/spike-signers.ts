/**
 * Devnet spike signers. The payer sponsors mint/ATA rent; the delegatee is the
 * only key that can pull against a delegation. Both are devnet-only and neither
 * can move user funds outside the cap the program enforces.
 *
 * A failure is logged as a fixed line: never the error's text, which for a
 * malformed key file quotes the file's bytes (keyfile.ts).
 */
import { writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { createKeyPairSignerFromBytes, type TransactionSigner } from '@solana/kit'
import { keypairFromFile, SecretFileError } from './keyfile.js'

export async function loadDelegationSigners(
  env: NodeJS.ProcessEnv,
  delegateePathDefault: string,
  log: (line: string) => void = (l) => console.log(l),
): Promise<{ payer: TransactionSigner; delegatee: TransactionSigner } | undefined> {
  const payerPath = env.SPIKE_PAYER ?? `${env.HOME}/.config/solana/id.json`
  try {
    const payer = await keypairFromFile(payerPath, 'SPIKE_PAYER')
    // The delegatee must survive restarts: the device signs a delegation that
    // names this exact key, so regenerating it would orphan every delegation.
    const delegateePath = env.SPIKE_DELEGATEE ?? delegateePathDefault
    let delegatee
    try {
      delegatee = await keypairFromFile(delegateePath, 'SPIKE_DELEGATEE')
    } catch {
      // kit's generateKeyPairSigner() produces a non-extractable CryptoKey, so it
      // cannot be persisted. Generate an extractable ed25519 pair and store it in
      // the CLI's 64-byte [secret||public] layout instead.
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const priv = privateKey.export({ format: 'jwk' })
      const pub = publicKey.export({ format: 'jwk' })
      if (typeof priv.d !== 'string' || typeof pub.x !== 'string') throw new Error('could not export delegatee key')
      const secret = new Uint8Array(64)
      secret.set(Buffer.from(priv.d, 'base64url'), 0)
      secret.set(Buffer.from(pub.x, 'base64url'), 32)
      await writeFile(delegateePath, JSON.stringify(Array.from(secret)), { mode: 0o600 })
      delegatee = await createKeyPairSignerFromBytes(secret)
      log(`delegation spike: generated new delegatee at ${delegateePath}`)
    }
    log(`delegation spike: payer ${payer.address} delegatee ${delegatee.address}`)
    return { payer, delegatee }
  } catch (error) {
    // SecretFileError messages are fixed text naming the file's role; anything else is not logged.
    log(`delegation spike disabled: ${error instanceof SecretFileError ? error.message : 'a spike key did not load'}`)
    return undefined
  }
}
