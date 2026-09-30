/**
 * A simulated Subscriptions program for executor unit tests. It enforces the
 * same rules the real program does for a recurring pull (lazy whole-period
 * roll, per-period cap → Custom 400, hard expiry → Custom 128, closed
 * delegation → failure), plus the transport failures a real RPC produces:
 * throws, transactions that are sent but never land, and landed transactions
 * whose send call still threw. The localnet suite checks the same executor
 * against the real program.
 */
import type { ChainPort } from '../executor.js'
import type { Mandate } from '../mandate-store.js'
import type { RecurringState } from '../mandate-chain.js'
import type { Landed, SignedTx, TxStatus } from '../tx.js'

interface Deleg {
  delegatee: string
  delegator: string
  mint: string
  amountPerPeriod: bigint
  pulled: bigint
  periodStart: bigint
  periodLength: bigint
  expiry: bigint
}

export class FakeChain implements ChainPort {
  nowS = 1_000_000n
  height = 100n
  delegations = new Map<string, Deleg>()
  landed = new Map<string, Landed>()
  sent: { sig: string; pda: string; amount: bigint }[] = []
  /** Every send() call, rebroadcasts included. */
  sends: string[] = []
  receiverValid = true
  /** Transport faults, consumed one per call. */
  readFailures = 0
  sendThrowsAfterApply = 0
  sendDrops = 0
  /** Runs inside send() before the program logic — lets a test move the chain underneath the executor. */
  beforeApply: ((pda: string) => void) | null = null
  private n = 0

  add(pda: string, d: Omit<Deleg, 'pulled'> & { pulled?: bigint }): void {
    this.delegations.set(pda, { pulled: 0n, ...d })
  }

  async read(pda: string): Promise<RecurringState> {
    if (this.readFailures > 0) {
      this.readFailures--
      throw new Error('fetch failed: https://rpc.example/?api-key=SUPERSECRET-KEY 503')
    }
    const d = this.delegations.get(pda)
    if (!d) return { exists: false }
    return {
      exists: true,
      delegator: d.delegator as never,
      delegatee: d.delegatee as never,
      mint: d.mint as never,
      amountPerPeriod: d.amountPerPeriod,
      amountPulledInPeriod: d.pulled,
      currentPeriodStartTs: d.periodStart,
      periodLengthS: d.periodLength,
      expiryTs: d.expiry,
    }
  }

  async receiverOk(_m: Mandate): Promise<boolean> {
    return this.receiverValid
  }

  async signPull(m: Mandate, amount: bigint): Promise<SignedTx> {
    const signature = `sig${++this.n}`
    return {
      signature,
      wire: JSON.stringify({ signature, pda: m.delegationPda, amount: amount.toString() }),
      lastValidBlockHeight: this.height + 150n,
    }
  }

  async send(wire: string): Promise<void> {
    const { signature, pda, amount } = JSON.parse(wire) as { signature: string; pda: string; amount: string }
    this.sends.push(signature)
    // Like the real chain: the same signed bytes land at most once.
    if (this.landed.has(signature)) return
    if (this.sendDrops > 0) {
      this.sendDrops--
      return // accepted by the RPC, never lands
    }
    this.beforeApply?.(pda)
    this.landed.set(signature, this.apply(signature, pda, BigInt(amount)))
    this.sent.push({ sig: signature, pda, amount: BigInt(amount) })
    if (this.sendThrowsAfterApply > 0) {
      this.sendThrowsAfterApply--
      throw new Error('socket hang up')
    }
  }

  private apply(signature: string, pda: string, amount: bigint): Landed {
    const fail = (code: number | null, err: string): Landed => ({ signature, err, customCode: code, logs: [] })
    const d = this.delegations.get(pda)
    if (!d) return fail(null, '{"InstructionError":[0,"InvalidAccountOwner"]}')
    if (d.expiry > 0n && this.nowS >= d.expiry) return fail(128, '{"InstructionError":[0,{"Custom":128}]}')
    if (this.nowS < d.periodStart) return fail(407, '{"InstructionError":[0,{"Custom":407}]}')
    const since = this.nowS - d.periodStart
    if (since >= d.periodLength) {
      d.periodStart += (since / d.periodLength) * d.periodLength
      d.pulled = 0n
    }
    if (amount > d.amountPerPeriod - d.pulled) return fail(400, '{"InstructionError":[0,{"Custom":400}]}')
    d.pulled += amount
    return { signature, err: null, customCode: null, logs: [] }
  }

  async status(signature: string, lastValidBlockHeight: bigint): Promise<TxStatus> {
    const l = this.landed.get(signature)
    if (l) return { state: 'landed', landed: l }
    return this.height > lastValidBlockHeight ? { state: 'expired' } : { state: 'pending' }
  }
}
