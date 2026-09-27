import path from 'node:path'
import { loadConfig } from './config.js'
import { openDb, Store } from './db.js'
import { createApp } from './app.js'
import { FcmSender } from './fcm.js'
import { readFile, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { createKeyPairSignerFromBytes, createSolanaRpc, type TransactionSigner } from '@solana/kit'
import { loadMandateConfig } from './mandate-config.js'
import { MandateStore } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
import { Executor, rpcChain, startExecutor } from './executor.js'
import { Guard, rpcGuardChain, startGuard } from './guard.js'
import { runDigests } from './digest-scheduler.js'
import { liveMandatesFor } from './mandates-api.js'
import { createLogger } from './log.js'

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
async function loadDelegationSigners(): Promise<
  { payer: TransactionSigner; delegatee: TransactionSigner } | undefined
> {
  const payerPath = process.env.SPIKE_PAYER ?? `${process.env.HOME}/.config/solana/id.json`
  try {
    const payer = createKeyPairSignerFromBytes(
      new Uint8Array(JSON.parse(await readFile(payerPath, 'utf8')) as number[]),
    )
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

// The BRIEF-05/06 spike routes (/api/delegation/*) can trigger pulls with an
// arbitrary amount. They only exist when explicitly asked for — never because a
// CLI keypair happens to sit in the default path on the host.
const delegationSigners = process.env.SPIKE_ROUTES === '1' ? await loadDelegationSigners() : undefined

/**
 * mandatum. Off unless MANDATE_CLUSTER is set. On mainnet the executor key must
 * already exist at MANDATE_DELEGATEE (and be funded for fees): the server never
 * invents a mainnet key. On localnet one is generated on first start.
 */
const log = createLogger()
const mandateConfig = loadMandateConfig(process.env, config.heliusRpc)
async function loadMandateDelegatee(path: string | null, cluster: 'mainnet' | 'localnet'): Promise<TransactionSigner> {
  if (!path) throw new Error('MANDATE_DELEGATEE (path to the executor keypair) is required')
  try {
    return await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(path, 'utf8')) as number[]))
  } catch (e) {
    if (cluster === 'mainnet') throw e
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const priv = privateKey.export({ format: 'jwk' })
    const pub = publicKey.export({ format: 'jwk' })
    if (typeof priv.d !== 'string' || typeof pub.x !== 'string') throw new Error('could not export delegatee key')
    const secret = new Uint8Array(64)
    secret.set(Buffer.from(priv.d, 'base64url'), 0)
    secret.set(Buffer.from(pub.x, 'base64url'), 32)
    await writeFile(path, JSON.stringify(Array.from(secret)), { mode: 0o600 })
    return createKeyPairSignerFromBytes(secret)
  }
}

let mandateDeps: Parameters<typeof createApp>[4]
if (mandateConfig) {
  const rpc = createSolanaRpc(mandateConfig.rpcUrl)
  const delegatee = await loadMandateDelegatee(mandateConfig.delegateePath, mandateConfig.cluster)
  const mandates = new MandateStore(db)
  const push: PushPort | null = fcm
    ? {
        async toAddress(address, msg) {
          const tokens = store.getPushTokens(address)
          const results = await Promise.all(
            tokens.map((t) =>
              fcm.send(t, { title: msg.title, body: msg.body }, 'alerts', { url: msg.url, channelId: 'alerts' }),
            ),
          )
          return results.map((r) => r.status)
        },
      }
    : null
  const receipts = new Receipts(mandates, push, log, mandateConfig.cluster)
  const executor = new Executor({ store: mandates, chain: rpcChain(rpc, delegatee), receipts, log })
  const guard = new Guard({
    store: mandates,
    chain: rpcGuardChain(rpc),
    receipts,
    log,
    addresses: () => [...new Set([...store.pushAddresses(), ...mandates.activeMandates().map((m) => m.address)])],
    mintInfo: (mint) =>
      mandateConfig.mints.find((m) => m.mint === mint) ?? { symbol: `${mint.slice(0, 4)}…`, decimals: 0 },
  })
  startExecutor(executor, mandateConfig.executorIntervalMs)
  startGuard(guard, mandateConfig.guardIntervalMs)
  if (push) {
    setInterval(
      () =>
        void runDigests(
          { store, mandates, push, log, live: (a) => liveMandatesFor(rpc, mandates, mandateConfig, a, Date.now()) },
          Date.now(),
        ),
      60_000,
    )
  }
  mandateDeps = { mandates, cfg: mandateConfig, rpc, delegatee: delegatee.address, receipts, executor }
  log.info('mandates_enabled', {
    cluster: mandateConfig.cluster,
    delegatee: delegatee.address,
    mints: mandateConfig.mints.map((m) => m.symbol).join(','),
    maxPerPeriod: mandateConfig.maxPerPeriodUi,
    demo: mandateConfig.demoEndpoints,
  })
}

const app = createApp(config, store, fcm, delegationSigners, mandateDeps)

// Loopback only: during development the Seeker reaches this through `adb reverse`,
// and in production nginx terminates in front. Nothing here belongs on the LAN.
app.listen(config.port, '127.0.0.1', () => {
  console.log(
    `nuntius server on 127.0.0.1:${config.port} · domain ${config.domain} · helius ${config.heliusRpc ? 'configured' : 'NOT configured'} · fcm ${fcm ? 'configured' : 'NOT configured'}`,
  )
  // Printed, not assumed: on mainnet these four numbers are the difference
  // between a capped test and an uncapped one.
  const d = config.delegation
  console.log(
    `delegation · cluster ${d.cluster} · mint ${d.mint ?? '(devnet mints its own)'} · cap ${d.capBaseUnits} base units · period ${d.periodLengthS}s · decimals ${d.decimals} · receiver ${d.receiverAta ?? "(delegatee's own ATA, created on first pull)"}`,
  )
})
