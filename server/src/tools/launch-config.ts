/**
 * nuntius's partner config for one quote token: created once, then every launch priced in
 * that token is a pool on it (/api/launch/create, LAUNCH_CONFIGS).
 *
 *   cd server && npm run build
 *   RPC=<mainnet rpc> node dist/tools/launch-config.js SKR             # simulate only (default)
 *   RPC=<mainnet rpc> node dist/tools/launch-config.js SKR --payer <address with SOL>
 *   RPC=<mainnet rpc> PAYER_KEY=<key file> node dist/tools/launch-config.js SKR --send
 *
 * Without --send nothing is signed or sent: the transaction is simulated with signature
 * checks off, and the tool prints the decoded config parameters, the size, the compute and
 * what it costs the payer. --send signs with PAYER_KEY (the executor's key file; never
 * printed) and a fresh config key, sends, and reads the config back from the chain.
 * The RPC URL is never printed.
 */
import { Connection, PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import { configInstructions, launchPreset, PRESET_MIGRATION_PCT } from '../meteora.js'
import { keypairFromFile } from '../keyfile.js'
import { sendWire, simulateCost, waitFor } from '../tx.js'

/** The fee claimer and leftover receiver: the cj7 treasury (decision D2, 5 Oct). */
const TREASURY = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7'
/** The nuntius executor, which pays for the config account. */
const EXECUTOR = '23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP'

/**
 * Quote token, mint, and migration threshold. USDC: 750, the value in Meteora's keeper
 * table. SKR: 50,000, about 900 USD at 0.0180 USD per SKR (Jupiter, 5 Oct 21:44 UTC; Jupiter
 * Verified, organic score 76), above the keepers' 750 USD notional for verified quotes; the
 * executor's crank migrates it either way.
 */
const QUOTES: Record<string, { mint: string; threshold: number }> = {
  SKR: { mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3', threshold: 50_000 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', threshold: 750 },
}

const symbol = process.argv[2] ?? ''
const send = process.argv.includes('--send')
const payerArg = process.argv.includes('--payer') ? process.argv[process.argv.indexOf('--payer') + 1] : undefined
const q = QUOTES[symbol]
if (!q) {
  console.error(`usage: launch-config.js SKR|USDC [--payer <address>] [--send]`)
  process.exit(2)
}
const rpcUrl = process.env.RPC ?? ''
if (!rpcUrl.startsWith('https://')) {
  console.error('RPC must be set to an https mainnet RPC URL (it is never printed)')
  process.exit(2)
}

/** BN, PublicKey and nested values as plain JSON for review. */
const plain = (v: unknown): unknown =>
  BN.isBN(v)
    ? (v as BN).toString()
    : v instanceof PublicKey
      ? v.toBase58()
      : Array.isArray(v)
        ? v.map(plain)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
          : v

const conn = new Connection(rpcUrl, 'confirmed')
const rpc = createSolanaRpc(rpcUrl)
const payer: TransactionSigner = send
  ? await keypairFromFile(process.env.PAYER_KEY ?? '', 'executor key')
  : createNoopSigner((payerArg ?? EXECUTOR) as Address)
if (send && payer.address !== EXECUTOR) throw new Error(`PAYER_KEY is ${payer.address}, not the executor ${EXECUTOR}`)
const configKey = await generateKeyPairSigner()
const params = launchPreset(q.threshold)
const ixs = await configInstructions(conn, {
  config: configKey.address,
  feeClaimer: TREASURY,
  leftoverReceiver: TREASURY,
  quoteMint: q.mint,
  payer: payer.address,
  quoteThreshold: q.threshold,
})
const signers = new Map<string, TransactionSigner>([
  [configKey.address, configKey],
  [payer.address, payer],
])
const withSigners = ixs.map((ix) => ({
  ...ix,
  accounts: ix.accounts?.map((a) => (signers.has(a.address) ? { ...a, signer: signers.get(a.address)! } : a)),
})) as Instruction[]
const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
const msg = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(payer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) => appendTransactionMessageInstructions(withSigners, m),
)
const signed = await partiallySignTransactionMessageWithSigners(msg)
const wire = getBase64EncodedWireTransaction(signed)
const sim = await simulateCost(rpc, wire, payer.address)

const report = {
  quote: symbol,
  quoteMint: q.mint,
  config: configKey.address,
  feeClaimer: TREASURY,
  leftoverReceiver: TREASURY,
  payer: payer.address,
  percentageSupplyOnMigration: PRESET_MIGRATION_PCT,
  migrationQuoteThresholdUi: q.threshold,
  transactionBytes: Buffer.from(wire, 'base64').length,
  simulation: { err: sim.err, unitsConsumed: sim.unitsConsumed, payerCostLamports: sim.cost?.toString() ?? null },
  configParameters: plain(params),
}
console.log(JSON.stringify(report, null, 2))
if (!send) process.exit(sim.err ? 1 : 0)
if (sim.err) throw new Error(`the simulation failed (${sim.err}); nothing sent`)

await sendWire(rpc, wire)
const landed = await waitFor(rpc, getSignatureFromTransaction(signed), blockhash.lastValidBlockHeight)
if (landed.err) throw new Error(`landed with an error: ${landed.err}`)
const back = await new DBC.DynamicBondingCurveClient(conn, 'confirmed').state.getPoolConfig(configKey.address)
console.log(JSON.stringify({ signature: landed.signature, config: configKey.address, readBack: plain(back) }, null, 2))
