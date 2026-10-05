/**
 * Preview harness: the real server + the real program on a LOCAL validator,
 * seeded with a believable wallet, serving the app's web export from the same
 * origin. Used to render the actual screens for review and for the deck.
 *
 *   scripts/localnet.sh &                       # validator with the program
 *   npx expo export -p web --output-dir /tmp/web
 *   cd server && npm run build && WEB_DIR=/tmp/web node dist/tools/preview-server.js
 *
 * Everything here is localnet: keys are generated in memory, tokens are a
 * test mint named tUSDC, and the Seeker tier is set directly in the test DB.
 * Screenshots taken from it must be captioned as such.
 */
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import express from 'express'
import { createApp } from '../app.js'
import { openDb, Store } from '../db.js'
import { MandateStore } from '../mandate-store.js'
import { Receipts } from '../receipts.js'
import { Executor, rpcChain } from '../executor.js'
import { Guard, rpcGuardChain } from '../guard.js'
import { createLogger } from '../log.js'
import { buildGrantTx, pullInstruction } from '../mandate-chain.js'
import { signAndSend } from '../tx.js'
import type { Config } from '../config.js'
import { assertOk, ataFor, deviceSignAndSend, funded, LOCALNET_RPC, mintTo, requireLocal } from '../test/localnet.js'

const WEB_DIR = process.env.WEB_DIR
if (!WEB_DIR) throw new Error('WEB_DIR (the expo web export) is required')
if (!LOCALNET_RPC) throw new Error('LOCALNET_RPC is required')
const PORT = Number(process.env.PREVIEW_PORT ?? 8787)

const rpc = requireLocal()
const owner = await funded(rpc, 5)
const delegatee = await funded(rpc, 5)
const ana = await funded(rpc)
const gym = await funded(rpc)
const merchant = await funded(rpc)
const { mint } = await mintTo(rpc, owner, owner.address, 250_000_000n) // 250 tUSDC
const { mint: skrMint } = await mintTo(rpc, owner, owner.address, 5_000_000_000n) // 5000 tSKR
await ataFor(rpc, ana, mint, ana.address)
await ataFor(rpc, gym, mint, gym.address)
await ataFor(rpc, gym, skrMint, gym.address)
const merchantAta = await ataFor(rpc, merchant, mint, merchant.address)

const db = openDb(':memory:')
const store = new Store(db)
const mandates = new MandateStore(db)
const pushes: string[] = []
const log = createLogger(() => {})
const receipts = new Receipts(mandates, { toAddress: async (_a, m) => (pushes.push(m.title), [200]) }, log, 'localnet')
const executor = new Executor({ store: mandates, chain: rpcChain(rpc, delegatee), receipts, log })
const guard = new Guard({
  store: mandates,
  chain: rpcGuardChain(rpc),
  receipts,
  log,
  addresses: () => [owner.address],
  mintInfo: (m) => (m === skrMint ? { symbol: 'tSKR', decimals: 6 } : { symbol: 'tUSDC', decimals: 6 }),
})
const cfg = {
  cluster: 'localnet' as const,
  rpcUrl: LOCALNET_RPC,
  mints: [
    { symbol: 'tUSDC', mint, decimals: 6, maxPerPeriodUi: '1' },
    { symbol: 'tSKR', mint: skrMint, decimals: 6, maxPerPeriodUi: '55' },
  ],
  maxPerPeriodUi: '100',
  delegateePath: null,
  executorIntervalMs: 30_000,
  guardIntervalMs: 60_000,
  demoEndpoints: true,
  launches: false,
  launchConfigs: {},
}
const config = {
  port: PORT,
  domain: 'localhost',
  heliusRpc: null,
  fcmServiceAccount: null,
  fcmProjectId: null,
} as unknown as Config
const api = createApp(config, store, null, {
  mandates,
  cfg,
  rpc,
  delegatee: delegatee.address,
  receipts,
  executor,
})

const session = 'Preview' + 'x'.repeat(33) + 'abc'
store.createSession(session, owner.address, Date.now())
store.claimSgtMint(session, 'LocalnetSimulatedSgtMint11111111111111111111')

async function call(p: string, body: Record<string, unknown>) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, ...body }),
  })
  const j = (await r.json()) as Record<string, any>
  if (!j.ok) throw new Error(`${p}: ${JSON.stringify(j)}`)
  return j
}

const web = express()
web.use((req, res, next) => (req.path.startsWith('/api/') ? api(req, res, next) : next()))
web.use(express.static(WEB_DIR, { extensions: ['html'] }))
web.use((_req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')))
await new Promise<void>((r) => web.listen(PORT, '127.0.0.1', () => r()))

// Seed: two nuntius mandates, one foreign delegation, real pulls, a real refusal.
await guard.tick() // silent baseline (nothing yet)
for (const t of [
  { label: 'Rent to Ana', payee: ana.address, amount: '0.05', period: 'day', untilDays: 30, symbol: 'tUSDC' },
  { label: 'Gym', payee: gym.address, amount: '0.01', period: 'hour', untilDays: 30, symbol: 'tUSDC' },
  { label: 'Club', payee: gym.address, amount: '25', period: 'week', untilDays: 90, symbol: 'tSKR' },
]) {
  const c = await call('/api/mandates/create', t)
  assertOk(await deviceSignAndSend(rpc, owner, c.transactionBase64))
  await call('/api/mandates/confirm', { mandateId: c.mandateId })
}
const foreign = await buildGrantTx(rpc, {
  owner: owner.address,
  mint,
  delegatee: merchant.address,
  nonce: 0n,
  amountPerPeriod: 500_000n,
  periodLengthS: 86_400n,
  startTs: 0n,
  expiryTs: BigInt(Math.floor(Date.now() / 1000) + 20 * 86_400),
})
assertOk(await deviceSignAndSend(rpc, owner, foreign.transactionBase64))
await guard.tick()
await executor.tick()
assertOk(
  await signAndSend(rpc, merchant, [
    await pullInstruction({
      delegatee: merchant,
      delegationPda: foreign.delegationPda,
      delegator: owner.address,
      delegatorAta: (await import('../mandate-chain.js').then((m) => m.userAtaOf(owner.address, mint))) as never,
      receiverAta: merchantAta,
      mint,
      amount: 120_000n,
    }),
  ]),
)
const gymMandate = mandates.listMandates(owner.address).find((m) => m.label === 'Rent to Ana')!
await executor.demoOverCap(gymMandate)
await guard.tick()
const today = new Date()
for (let i = 1; i <= 3; i++) {
  const d = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10)
  mandates.clockIn(owner.address, d, today.getTime() - i * 86_400_000)
}
mandates.setDigestPrefs(owner.address, 8, 180, true, 0)

const auth = { address: owner.address, session, sgtMint: 'LocalnetSimulatedSgtMint11111111111111111111' }
writeFileSync(process.env.AUTH_OUT ?? '/tmp/nuntius-preview-auth.json', JSON.stringify(auth))
console.log(`preview ready on http://127.0.0.1:${PORT}`)
console.log(`owner ${owner.address}`)
console.log(`receipts pushed: ${pushes.join(' | ')}`)
