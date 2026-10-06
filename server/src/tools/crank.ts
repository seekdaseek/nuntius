/**
 * Migrates one filled DBC curve to its canonical DAMM v2 pool with the executor's own crank
 * (Executor.crank, the code that runs in production for backed pools). For a curve nobody
 * backs yet but that must migrate: Meteora's keepers skip small curves.
 *
 *   cd server && npm run build
 *   RPC=<mainnet rpc> PAYER_KEY=<executor key file> node dist/tools/crank.js <pool>          # simulate
 *   RPC=<mainnet rpc> PAYER_KEY=<executor key file> node dist/tools/crank.js <pool> --send
 *
 * The RPC URL and the key are never printed.
 */
import Database from 'better-sqlite3'
import { createSolanaRpc } from '@solana/kit'
import { Executor, rpcChain } from '../executor.js'
import { MandateStore } from '../mandate-store.js'
import { Receipts } from '../receipts.js'
import { createLogger } from '../log.js'
import { meteoraConnection } from '../meteora.js'
import { keypairFromFile } from '../keyfile.js'
import { PULL_BUDGET } from '../tx.js'

const EXECUTOR = '23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP'
const pool = process.argv[2] ?? ''
const send = process.argv.includes('--send')
const rpcUrl = process.env.RPC ?? ''
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool) || !rpcUrl.startsWith('https://')) {
  console.error('usage: RPC=<https mainnet rpc> [PAYER_KEY=<file>] node dist/tools/crank.js <pool> [--send]')
  process.exit(2)
}
const rpc = createSolanaRpc(rpcUrl)
const conn = meteoraConnection(rpcUrl)
// The crank signs its migration (with two fresh position keys) before simulating it, so the
// key is loaded either way; without --send nothing leaves this machine but the simulation.
const executor = await keypairFromFile(process.env.PAYER_KEY ?? '', 'executor key')
if (executor.address !== EXECUTOR) throw new Error(`PAYER_KEY is ${executor.address}, not the executor`)
const chain = rpcChain(rpc, executor, PULL_BUDGET, conn)

const step = await chain.migration!(pool)
if (step.kind !== 'ready') {
  console.log(JSON.stringify({ pool, stage: step.kind, ...('dammPool' in step ? { dammPool: step.dammPool } : {}) }))
  process.exit(0)
}
console.log(
  JSON.stringify({
    pool,
    stage: 'filled, not migrated',
    dammPool: step.dammPool,
    simulation: { err: step.simErr, costLamports: step.costLamports?.toString() ?? null },
    executorLamports: step.balanceLamports.toString(),
  }),
)
if (!send) process.exit(step.simErr ? 1 : 0)

const lines: string[] = []
const log = createLogger((l) => {
  lines.push(l)
  console.log(l)
})
const store = new MandateStore(new Database(':memory:'))
const ex = new Executor({
  store,
  chain,
  receipts: new Receipts(store, null, log, 'mainnet'),
  log,
  migrateAfterMs: 0,
  migrationBudgetLamports: 30_000_000n,
  floorLamports: 2_000_000n,
})
const outcome = await ex.crank(pool)
const m = store.migrationOf(pool)
console.log(JSON.stringify({ outcome, migration: m }))
process.exit(outcome === 'landed' ? 0 : 1)
