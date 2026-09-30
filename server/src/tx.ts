/**
 * Transaction plumbing shared by the mandate chain layer, the executor and the
 * localnet tests. Two shapes only:
 *
 * - `compileUnsigned` — a transaction the DEVICE signs. The server never holds
 *   the user's key, so it hands back base64 wire bytes with the owner as fee
 *   payer and sole required signer.
 * - `signAndSend` — a transaction a SERVER key signs (the delegatee's pull).
 *   It reports what the ledger recorded instead of throwing on a program
 *   error, because a refused pull is evidence, not an exception.
 */
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'

export type Rpc = ReturnType<typeof createSolanaRpc>

export interface Blockhash {
  blockhash: string
  lastValidBlockHeight: bigint
}

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111' as Address

/**
 * Compute budget for a transaction the delegatee pays for: a unit limit near
 * what it needs, and a small price per unit so validators under load still
 * schedule it (30 Sep: 3 of 5 first sends were dropped). The priority fee is
 * limit × price, charged on the limit, not on what was used.
 */
export interface ComputeBudget {
  unitLimit: number
  microLamportsPerUnit: number
}

/**
 * A pull measured 14,831 units on localnet (SPL Token; a refused one, 970).
 * 40,000 leaves room for Token-2022 mints such as SKR. At 50,000 micro-lamports
 * a unit the priority fee is 2,000 lamports a pull (0.000002 SOL), on top of
 * the 5,000-lamport base fee.
 */
export const PULL_BUDGET: ComputeBudget = { unitLimit: 40_000, microLamportsPerUnit: 50_000 }

export function priorityFeeLamports(b: ComputeBudget): bigint {
  return (BigInt(b.unitLimit) * BigInt(b.microLamportsPerUnit) + 999_999n) / 1_000_000n
}

export function computeBudgetInstructions(b: ComputeBudget): Instruction[] {
  const limit = new Uint8Array(5)
  limit[0] = 2 // SetComputeUnitLimit(u32)
  new DataView(limit.buffer).setUint32(1, b.unitLimit, true)
  const price = new Uint8Array(9)
  price[0] = 3 // SetComputeUnitPrice(u64, micro-lamports)
  new DataView(price.buffer).setBigUint64(1, BigInt(b.microLamportsPerUnit), true)
  return [
    { programAddress: COMPUTE_BUDGET, data: limit },
    { programAddress: COMPUTE_BUDGET, data: price },
  ]
}

export async function latestBlockhash(rpc: Rpc): Promise<Blockhash> {
  const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight }
}

/** Unsigned v0 transaction, owner pays and signs. Returned as base64 wire bytes. */
export async function compileUnsigned(rpc: Rpc, feePayer: Address, instructions: Instruction[]): Promise<string> {
  const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(value, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  return getBase64Decoder().decode(getTransactionEncoder().encode(compileTransaction(message)))
}

export interface SignedTx {
  signature: string
  wire: string
  lastValidBlockHeight: bigint
}

/**
 * Signs locally WITHOUT sending, so the signature can be persisted first.
 * That ordering is what makes a pull idempotent across a crash: on restart the
 * executor asks the chain about the stored signature before it builds another.
 */
export async function signOnly(
  feePayer: TransactionSigner,
  instructions: Instruction[],
  blockhash: Blockhash,
): Promise<SignedTx> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer.address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash.blockhash as never, lastValidBlockHeight: blockhash.lastValidBlockHeight },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  return {
    signature: getSignatureFromTransaction(signed),
    wire: getBase64EncodedWireTransaction(signed),
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  }
}

export interface Landed {
  signature: string
  /** Program error as recorded on chain, JSON; null when the transaction succeeded. */
  err: string | null
  /** Custom program error code when there is one (e.g. 400 = 0x190). */
  customCode: number | null
  logs: string[]
}

/**
 * Sends pre-signed wire bytes with preflight off, so a refusal lands and has a
 * signature. The RPC node keeps forwarding it until its blockhash expires (no
 * maxRetries: 0, which let a dropped pull sit for 40 s on 30 Sep).
 */
export async function sendWire(rpc: Rpc, wire: string): Promise<void> {
  await rpc.sendTransaction(wire as never, { encoding: 'base64', skipPreflight: true }).send()
}

export type TxStatus = { state: 'landed'; landed: Landed } | { state: 'pending' } | { state: 'expired' }

/**
 * What the chain knows about a signature right now. `expired` is only returned
 * once the blockhash can no longer land, which is the one moment it is safe to
 * build a replacement transaction.
 */
export async function statusOf(rpc: Rpc, signature: string, lastValidBlockHeight: bigint): Promise<TxStatus> {
  const { value } = await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send()
  const st = value[0]
  if (st && (st.err || st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
    return { state: 'landed', landed: await readLanded(rpc, signature, st.err) }
  }
  const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send()
  if (height > lastValidBlockHeight) {
    // One more look: it may have landed between the two reads.
    const again = await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send()
    const st2 = again.value[0]
    if (st2 && (st2.err || st2.confirmationStatus === 'confirmed' || st2.confirmationStatus === 'finalized')) {
      return { state: 'landed', landed: await readLanded(rpc, signature, st2.err) }
    }
    return { state: 'expired' }
  }
  return { state: 'pending' }
}

async function readLanded(rpc: Rpc, signature: string, err: unknown): Promise<Landed> {
  const tx = await rpc
    .getTransaction(signature as never, {
      maxSupportedTransactionVersion: 0,
      encoding: 'json',
      commitment: 'confirmed',
    })
    .send()
    .catch(() => null)
  const errJson = err ? JSON.stringify(err, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v)) : null
  return {
    signature,
    err: errJson,
    customCode: customCodeOf(err),
    logs: ((tx?.meta?.logMessages as string[] | undefined) ?? []).slice(),
  }
}

/** Extracts `Custom(n)` from an InstructionError, in either shape the RPC may return. */
export function customCodeOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const ie = (err as { InstructionError?: unknown }).InstructionError
  if (!Array.isArray(ie) || ie.length < 2) return null
  const inner = ie[1] as unknown
  if (inner && typeof inner === 'object' && 'Custom' in inner) {
    const c = (inner as { Custom: unknown }).Custom
    return typeof c === 'number' ? c : typeof c === 'bigint' ? Number(c) : null
  }
  return null
}

/** Sign, send, wait. For server-side setup and tests; the executor uses the split steps. */
export async function signAndSend(
  rpc: Rpc,
  feePayer: TransactionSigner,
  instructions: Instruction[],
  timeoutMs = 30_000,
): Promise<Landed> {
  const signed = await signOnly(feePayer, instructions, await latestBlockhash(rpc))
  await sendWire(rpc, signed.wire)
  return waitFor(rpc, signed.signature, signed.lastValidBlockHeight, timeoutMs)
}

export async function waitFor(
  rpc: Rpc,
  signature: string,
  lastValidBlockHeight: bigint,
  timeoutMs = 30_000,
): Promise<Landed> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await statusOf(rpc, signature, lastValidBlockHeight)
    if (s.state === 'landed') return s.landed
    if (s.state === 'expired') throw new Error(`transaction ${signature} expired without landing`)
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`transaction ${signature} not confirmed within ${timeoutMs}ms`)
}
