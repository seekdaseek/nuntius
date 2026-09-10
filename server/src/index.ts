import path from 'node:path'
import { loadConfig } from './config.js'
import { openDb, Store } from './db.js'
import { createApp } from './app.js'
import { FcmSender } from './fcm.js'
import { readFile, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { createKeyPairSignerFromBytes, type TransactionSigner } from '@solana/kit'

const config = loadConfig()
const db = openDb(path.join(import.meta.dirname, '..', 'nuntius.db'))
const store = new Store(db)
const fcm =
  config.fcmServiceAccount && config.fcmProjectId ? new FcmSender(config.fcmServiceAccount, config.fcmProjectId) : null
/**
 * Devnet spike signers. The payer sponsors mint/ATA rent; the delegatee is the
 * only key that can pull against a delegation. Both are devnet-only and neither
 * can move user funds outside the cap the program enforces.
 */
async function loadDelegationSigners(): Promise<{ payer: TransactionSigner; delegatee: TransactionSigner } | undefined> {
  const payerPath = process.env.SPIKE_PAYER ?? `${process.env.HOME}/.config/solana/id.json`
  try {
    const payer = createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(payerPath, 'utf8')) as number[]))
    // The delegatee must survive restarts: the device signs a delegation that
    // names this exact key, so regenerating it would orphan every delegation.
    const delegateePath = process.env.SPIKE_DELEGATEE ?? path.join(import.meta.dirname, '..', 'delegatee.json')
    let delegatee
    try {
      delegatee = await createKeyPairSignerFromBytes(
        new Uint8Array(JSON.parse(await readFile(delegateePath, 'utf8')) as number[]),
      )
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
      console.log(`delegation spike: generated new delegatee at ${delegateePath}`)
    }
    const resolvedPayer = await payer
    console.log(`delegation spike: payer ${resolvedPayer.address} delegatee ${delegatee.address}`)
    return { payer: resolvedPayer, delegatee }
  } catch (error) {
    console.log(`delegation spike disabled: ${error instanceof Error ? error.message : 'no payer keypair'}`)
    return undefined
  }
}

const delegationSigners = await loadDelegationSigners()
const app = createApp(config, store, fcm, delegationSigners)

// Loopback only: during development the Seeker reaches this through `adb reverse`,
// and in production nginx terminates in front. Nothing here belongs on the LAN.
app.listen(config.port, '127.0.0.1', () => {
  console.log(
    `nuntius server on 127.0.0.1:${config.port} · domain ${config.domain} · helius ${config.heliusRpc ? 'configured' : 'NOT configured'} · fcm ${fcm ? 'configured' : 'NOT configured'}`,
  )
})
