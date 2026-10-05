/**
 * What each mainnet step of the Meteora launch plan costs, measured before anything is paid:
 * every transaction is built as the server builds it and simulated on mainnet with signature
 * checks off. Nothing is signed or sent. Where the real payer cannot afford a step yet, a
 * funded stand-in pays in the simulation; rent and fees are the same whoever pays.
 *
 *   cd server && npm run build && RPC=<mainnet rpc> node dist/tools/mainnet-costs.js > ../evidence/mainnet-costs.json
 *
 * The migration cannot be simulated before a curve has filled. Its cost is derived from the
 * local run on the deployed programs (evidence/meteora-localnet-results.json, step 6): the
 * rent there divided by the local rent rate, times mainnet's, plus the same fee. Every
 * rent-exempt minimum is (bytes + 128) x rate, so the conversion is exact; it is labelled.
 */
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit'
import { getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import { ataOf, budgetInstructions, BUY_BUDGET, launchPreset, MIGRATION_BUDGET, toKit } from '../meteora.js'
import { buildGrantTx } from '../mandate-chain.js'
import { backerAccountInstruction } from '../launch-api.js'
import { priorityFeeLamports, simulateCost, PULL_BUDGET, type Rpc } from '../tx.js'

const rpcUrl = process.env.RPC ?? ''
if (!rpcUrl.startsWith('https://')) throw new Error('RPC must be an https mainnet RPC URL (never printed)')
const rpc: Rpc = createSolanaRpc(rpcUrl)
const conn = new Connection(rpcUrl, 'confirmed')

const EXECUTOR = '23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP'
const CJ7 = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7'
const NATX = 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX'
const SKR = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** DAMM v2's pool authority: system-owned and funded; a simulation-only fee payer, never asked to sign. */
const STAND_IN = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC'

/** Simulates these instructions with `payer` as fee payer; extra signers are marked, never asked to sign. */
async function measure(label: string, payer: string, ixs: Instruction[]) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(payer as Address), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  )
  const wire = getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(msg))
  const sim = await simulateCost(rpc, wire, payer as Address)
  const row = {
    step: label,
    payer,
    bytes: Buffer.from(wire, 'base64').length,
    err: sim.err,
    unitsConsumed: sim.unitsConsumed,
    costLamports: sim.cost?.toString() ?? null,
    payerBalanceLamports: sim.balance.toString(),
  }
  console.error(`${label}: ${sim.err ? `FAILS ${sim.err}` : `${row.costLamports} lamports`}, ${row.bytes} B`)
  return row
}

/** Fresh keys marked as signers (they would sign; the simulation does not check). */
const signer = (ix: Instruction, addresses: string[]) =>
  ({
    ...ix,
    accounts: ix.accounts?.map((a) =>
      addresses.includes(a.address) ? { ...a, signer: createNoopSigner(a.address as Address), role: a.role } : a,
    ),
  }) as Instruction

const rows: Record<string, unknown>[] = []
const rentRate = Number((await rpc.getMinimumBalanceForRentExemption(0n).send()) / 128n)

// 1. nuntius's two partner configs (the executor pays), then the proof config.
const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
async function configIxs(quoteMint: string, threshold: number, payer: string) {
  const config = Keypair.generate().publicKey.toBase58()
  const tx = await client.partner.createConfig({
    ...launchPreset(threshold),
    config: new PublicKey(config),
    feeClaimer: new PublicKey(CJ7),
    leftoverReceiver: new PublicKey(CJ7),
    quoteMint: new PublicKey(quoteMint),
    payer: new PublicKey(payer),
  })
  return { config, ixs: tx.instructions.map(toKit).map((ix) => signer(ix, [config])) }
}
for (const [sym, mint, threshold] of [
  ['SKR', SKR, 50_000],
  ['USDC', USDC, 750],
] as const) {
  rows.push(await measure(`config ${sym} (executor pays)`, EXECUTOR, (await configIxs(mint, threshold, EXECUTOR)).ixs))
  rows.push(await measure(`config ${sym} (stand-in payer cj7)`, CJ7, (await configIxs(mint, threshold, CJ7)).ixs))
}

// 2. A launch: config and pool together, minus the config alone, is the pool (cj7 creates nimus).
// cj7 cannot afford both in one simulation, so a funded stand-in pays here: DAMM v2's pool
// authority, a system-owned account that pool creation never touches. Simulation only.
{
  const config = Keypair.generate().publicKey
  const baseMint = Keypair.generate().publicKey
  const tx = await client.partner.createConfigAndPool({
    ...launchPreset(50_000),
    config,
    feeClaimer: new PublicKey(CJ7),
    leftoverReceiver: new PublicKey(CJ7),
    quoteMint: new PublicKey(SKR),
    payer: new PublicKey(STAND_IN),
    tokenType: DBC.TokenType.SPLToken,
    preCreatePoolParam: {
      name: 'nimus',
      symbol: 'NIMUS',
      uri: 'https://nuntius.ochinimus.app/m/0000000000000000000000000000000000000000000.json',
      poolCreator: new PublicKey(STAND_IN),
      baseMint,
    },
  })
  const ixs = [
    ...budgetInstructions({ unitLimit: 400_000, microLamportsPerUnit: 50_000 }),
    ...tx.instructions.map(toKit).map((ix) => signer(ix, [config.toBase58(), baseMint.toBase58()])),
  ]
  const both = await measure('config + pool, SKR (stand-in pays both)', STAND_IN, ixs)
  rows.push(both)
}

// 3. The executor's own token accounts for each quote (a back permission needs one first).
for (const [sym, mint] of [
  ['USDC', USDC],
  ['SKR', SKR],
] as const) {
  const ata = await ataOf(EXECUTOR, mint)
  const ix = getCreateAssociatedTokenIdempotentInstruction({
    payer: createNoopSigner(CJ7 as Address),
    ata: ata as Address,
    owner: EXECUTOR as Address,
    mint: mint as Address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  rows.push(await measure(`executor ${sym} token account (stand-in payer cj7)`, CJ7, [ix]))
}

// 4. A back grant from natX in SKR (authority, delegation, finite approval, its own base account).
{
  const base = Keypair.generate().publicKey.toBase58()
  const { ix } = await backerAccountInstruction(NATX, base)
  const g = await buildGrantTx(
    rpc,
    {
      owner: NATX as Address,
      mint: SKR as Address,
      delegatee: EXECUTOR as Address,
      nonce: 1n,
      amountPerPeriod: 25_000_000n,
      periodLengthS: 604_800n,
      startTs: 0n,
      expiryTs: BigInt(Math.floor(Date.now() / 1000) + 90 * 86_400),
    },
    [],
  )
  rows.push({
    step: 'back grant natX, SKR (without the launch token account)',
    ...(await simulateWireCost(g.transactionBase64, NATX)),
  })
  rows.push({
    step: 'the launch token account a back grant adds',
    rentLamports: (await rpc.getMinimumBalanceForRentExemption(165n).send()).toString(),
    note: `${ix.programAddress}`,
  })
}

async function simulateWireCost(b64: string, payer: string) {
  const sim = await simulateCost(rpc, b64, payer as Address)
  console.error(`grant: ${sim.err ? `FAILS ${sim.err}` : `${sim.cost} lamports`}`)
  return { payer, err: sim.err, costLamports: sim.cost?.toString() ?? null, unitsConsumed: sim.unitsConsumed }
}

// 5. Fees per executor transaction, from the compute budgets (5,000 per signature plus priority).
const fees = {
  pullLamports: (5_000n + priorityFeeLamports(PULL_BUDGET)).toString(),
  buyLamports: (5_000n + priorityFeeLamports(BUY_BUDGET)).toString(),
}

// 6. The migration, derived from the local run on the deployed programs (see the header).
const local = JSON.parse(
  readFileSync(new URL('../../../evidence/meteora-localnet-results.json', import.meta.url), 'utf8'),
) as {
  steps: { step: string; costLamports?: string; feeLamports?: number }[]
}
const mig = local.steps.find((s) => s.step.startsWith('6 migration'))!
// Rent-exempt minimum = (bytes + 128) x rate: the local validator's default rate is 6,960, mainnet's is read above.
const LOCAL_RATE = 6_960n
const migRentLocal = BigInt(mig.costLamports!) - BigInt(mig.feeLamports!)
const migration = {
  step: 'migration by the crank (derived; executor pays)',
  localCostLamports: mig.costLamports,
  localFeeLamports: mig.feeLamports,
  localRentLamports: migRentLocal.toString(),
  mainnetRentRatePerByte: rentRate,
  derivedMainnetCostLamports: ((migRentLocal * BigInt(rentRate)) / LOCAL_RATE + BigInt(mig.feeLamports!)).toString(),
  exact: (migRentLocal * BigInt(rentRate)) % LOCAL_RATE === 0n,
  budget: MIGRATION_BUDGET,
  note: `rent = (bytes + 128) x rate; local rate ${LOCAL_RATE}, mainnet rate ${rentRate}`,
}

console.log(
  JSON.stringify(
    { measuredAt: new Date().toISOString(), slot: (await rpc.getSlot().send()).toString(), rows, fees, migration },
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ),
)
