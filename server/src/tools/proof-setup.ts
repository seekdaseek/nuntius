/**
 * The mainnet lifecycle proof (D2): the executor's token accounts for USDC and SKR (a back
 * permission needs one before its first buy), a "nuntius proof" config on the preset with a
 * 100 SKR threshold, and a pool on it named plainly as a test. The executor pays and creates;
 * natX then backs the pool from the Seeker, and the crank migrates it when it fills.
 *
 *   cd server && npm run build
 *   RPC=<mainnet rpc> node dist/tools/proof-setup.js                     # simulate only
 *   RPC=<mainnet rpc> PAYER_KEY=<executor key file> node dist/tools/proof-setup.js --send
 *
 * Every transaction is simulated right before it is sent; a failed simulation stops the run.
 * With --send the record goes to ../evidence/proof-setup.json. The RPC URL is never printed.
 */
import { writeFileSync } from 'node:fs'
import { Connection } from '@solana/web3.js'
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
import { getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { ataOf, configInstructions, dbcPoolAddress, launchInstructions } from '../meteora.js'
import { readAta } from '../mandate-chain.js'
import { keypairFromFile } from '../keyfile.js'
import { sendWire, simulateCost, waitFor, type Rpc } from '../tx.js'

const EXECUTOR = '23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP'
const TREASURY = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7'
const SKR = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** Small enough for natX to fill with two or three capped hourly buys; a proof, not a launch. */
export const PROOF_THRESHOLD_SKR = 100
const NAME = 'nuntius proof, not for trading'
const SYMBOL = 'PROOF'
const URI = 'https://nuntius.ochinimus.app/t/proof.json'

const send = process.argv.includes('--send')
const rpcUrl = process.env.RPC ?? ''
if (!rpcUrl.startsWith('https://')) throw new Error('RPC must be an https mainnet RPC URL (never printed)')
const rpc: Rpc = createSolanaRpc(rpcUrl)
const conn = new Connection(rpcUrl, 'confirmed')
const executor: TransactionSigner = send
  ? await keypairFromFile(process.env.PAYER_KEY ?? '', 'executor key')
  : createNoopSigner(EXECUTOR as Address)
if (executor.address !== EXECUTOR) throw new Error(`PAYER_KEY is ${executor.address}, not the executor`)

const record: Record<string, unknown>[] = []

/** Signs with every signer named in the instructions, simulates, and (with --send) sends and waits. */
async function step(label: string, ixs: Instruction[], extra: TransactionSigner[] = []) {
  const signers = new Map<string, TransactionSigner>([
    [executor.address, executor],
    ...extra.map((s) => [s.address, s] as const),
  ])
  const withSigners = ixs.map((ix) => ({
    ...ix,
    accounts: ix.accounts?.map((a) => (signers.has(a.address) ? { ...a, signer: signers.get(a.address)! } : a)),
  })) as Instruction[]
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const signed = await partiallySignTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(executor, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(withSigners, m),
    ),
  )
  const wire = getBase64EncodedWireTransaction(signed)
  const sim = await simulateCost(rpc, wire, executor.address)
  const row: Record<string, unknown> = {
    step: label,
    bytes: Buffer.from(wire, 'base64').length,
    simulation: { err: sim.err, unitsConsumed: sim.unitsConsumed, costLamports: sim.cost?.toString() ?? null },
  }
  console.log(`${label}: simulated ${sim.err ? `FAIL ${sim.err}` : `ok, ${sim.cost} lamports, ${row.bytes} B`}`)
  if (sim.err) throw new Error(`${label}: the simulation failed; nothing sent`)
  if (send) {
    await sendWire(rpc, wire)
    const landed = await waitFor(rpc, getSignatureFromTransaction(signed), bh.lastValidBlockHeight)
    if (landed.err) throw new Error(`${label}: landed with an error ${landed.err}`)
    row.signature = landed.signature
    console.log(`${label}: landed ${landed.signature}`)
  }
  record.push(row)
}

// 1. The executor's own token accounts for each quote token.
for (const [sym, mint] of [
  ['USDC', USDC],
  ['SKR', SKR],
] as const) {
  const ata = await ataOf(EXECUTOR, mint)
  if ((await readAta(rpc, ata as Address)).exists) {
    console.log(`executor ${sym} account ${ata}: exists`)
    continue
  }
  await step(`executor ${sym} account ${ata}`, [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: executor,
      ata: ata as Address,
      owner: EXECUTOR as Address,
      mint: mint as Address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
  ])
}

// 2. The proof config: the preset at a 100 SKR threshold, the same fee claimer as nuntius's.
const configKey = await generateKeyPairSigner()
await step(
  `proof config ${configKey.address}`,
  await configInstructions(conn, {
    config: configKey.address,
    feeClaimer: TREASURY,
    leftoverReceiver: TREASURY,
    quoteMint: SKR,
    payer: EXECUTOR,
    quoteThreshold: PROOF_THRESHOLD_SKR,
  }),
  [configKey],
)

// 3. The proof pool on it. The SDK reads the config from the chain, so this needs step 2 landed.
if (send) {
  const baseMint = await generateKeyPairSigner()
  const pool = dbcPoolAddress(SKR, baseMint.address, configKey.address)
  await step(
    `proof pool ${pool} (token ${baseMint.address})`,
    await launchInstructions(conn, {
      creator: EXECUTOR,
      config: configKey.address,
      name: NAME,
      symbol: SYMBOL,
      uri: URI,
      baseMint: baseMint.address,
    }),
    [baseMint],
  )
  writeFileSync(
    new URL('../../../evidence/proof-setup.json', import.meta.url),
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        config: configKey.address,
        pool,
        baseMint: baseMint.address,
        thresholdSkr: PROOF_THRESHOLD_SKR,
        name: NAME,
        symbol: SYMBOL,
        uri: URI,
        steps: record,
      },
      null,
      2,
    )}\n`,
  )
} else console.log('proof pool: simulated after the config lands (--send)')
