import { Connection } from '@solana/web3.js'
import { PULL_BUDGET } from './tx.js'
import path from 'node:path'
import { loadConfig } from './config.js'
import { openDb, Store } from './db.js'
import { createApp } from './app.js'
import { FcmSender } from './fcm.js'
import { writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { createKeyPairSignerFromBytes, createSolanaRpc, type TransactionSigner } from '@solana/kit'
import { loadMandateConfig } from './mandate-config.js'
import { MandateStore } from './mandate-store.js'
import { fcmParts, Receipts, type PushPort } from './receipts.js'
import { Executor, rpcChain, startExecutor } from './executor.js'
import { Guard, rpcGuardChain, startGuard } from './guard.js'
import { runDigests } from './digest-scheduler.js'
import { liveMandatesFor } from './mandates-api.js'
import { DelegationScans } from './mandate-chain.js'
import { pageConnection, withPagedProgramAccounts } from './program-accounts.js'
import { createLogger } from './log.js'
import { bootLines } from './boot-log.js'
import { keypairFromFile } from './keyfile.js'

const config = loadConfig()
const db = openDb(path.join(import.meta.dirname, '..', 'nuntius.db'))
const store = new Store(db)
const fcm =
  config.fcmServiceAccount && config.fcmProjectId ? new FcmSender(config.fcmServiceAccount, config.fcmProjectId) : null
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
    return await keypairFromFile(path, 'MANDATE_DELEGATEE')
  } catch (e) {
    // The error names the file's role, never its content (see keyfile.ts).
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

let mandateDeps: Parameters<typeof createApp>[3]
if (mandateConfig) {
  // Helius deprioritizes unpaginated getProgramAccounts: both clients page with getProgramAccountsV2 there.
  const rpc = withPagedProgramAccounts(createSolanaRpc(mandateConfig.rpcUrl), mandateConfig.rpcUrl)
  const scans = new DelegationScans(rpc)
  const delegatee = await loadMandateDelegatee(mandateConfig.delegateePath, mandateConfig.cluster)
  const mandates = new MandateStore(db)
  const push: PushPort | null = fcm
    ? {
        async toAddress(address, msg) {
          const tokens = store.getPushTokens(address)
          const results = await Promise.all(
            tokens.map((t) => {
              const p = fcmParts(msg)
              return fcm.send(t, p.notification, p.channelId, p.data, p.tag)
            }),
          )
          return results.map((r) => r.status)
        },
      }
    : null
  const receipts = new Receipts(mandates, push, log, mandateConfig.cluster)
  // The Meteora SDKs speak web3.js: one connection to the same RPC, for back permissions and launches.
  const conn = pageConnection(new Connection(mandateConfig.rpcUrl, 'confirmed'))
  const executor = new Executor({ store: mandates, chain: rpcChain(rpc, delegatee, PULL_BUDGET, conn), receipts, log })
  const guard = new Guard({
    store: mandates,
    chain: rpcGuardChain(rpc, scans),
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
  mandateDeps = {
    mandates,
    cfg: mandateConfig,
    rpc,
    delegatee: delegatee.address,
    receipts,
    executor,
    conn,
    origin: `https://${config.domain}`,
    scans,
  }
  log.info('mandates_enabled', {
    cluster: mandateConfig.cluster,
    delegatee: delegatee.address,
    mints: mandateConfig.mints.map((m) => m.symbol).join(','),
    maxPerPeriod: mandateConfig.maxPerPeriodUi,
    demo: mandateConfig.demoEndpoints,
  })
}

const app = createApp(config, store, fcm, mandateDeps)

// Loopback only: during development the Seeker reaches this through `adb reverse`,
// and in production nginx terminates in front. Nothing here belongs on the LAN.
app.listen(config.port, '127.0.0.1', () => {
  for (const line of bootLines(config, { fcm: Boolean(fcm) })) console.log(line)
})
