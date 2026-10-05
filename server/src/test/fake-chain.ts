/**
 * A simulated Subscriptions program for executor unit tests. It enforces the
 * same rules the real program does for a recurring pull (lazy whole-period
 * roll, per-period cap → Custom 400, hard expiry → Custom 128, closed
 * delegation → failure), plus the transport failures a real RPC produces:
 * throws, transactions that are sent but never land, and landed transactions
 * whose send call still threw. The localnet suite checks the same executor
 * against the real program.
 */
import type { ChainPort, PreparedBuy } from '../executor.js'
import type { Backing, Mandate } from '../mandate-store.js'
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
  /** Every sendProof() call: the over-cap demo's send without preflight. */
  proofSends: string[] = []
  receiverValid = true
  /** Transport faults, consumed one per call. */
  readFailures = 0
  sendThrowsAfterApply = 0
  sendDrops = 0
  /** Back permissions: the buy is pull + swap in one transaction. */
  buyWait: 'migrating' | 'nothing_left' | null = null
  buyRoute: 'dbc' | 'damm_v2' = 'dbc'
  dammPool: string | null = null
  /** Swaps that miss their minimum-out, consumed one per buy: the whole transaction fails. */
  swapFailures = 0
  swapFailureCode = 6002
  /** Balances the custody invariant is about: the executor's quote and base accounts, the backer's base. */
  delegateeQuote = 0n
  delegateeBase = 0n
  backerBase = 0n
  /** Launch tokens per quote base unit, for bought(). */
  price = 1000n
  private boughtBy = new Map<string, bigint>()
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

  async prepareBuy(m: Mandate, _b: Backing, amount: bigint): Promise<PreparedBuy> {
    if (this.buyWait) return { kind: 'wait', reason: this.buyWait }
    const signature = `buy${++this.n}`
    return {
      kind: 'buy',
      signed: {
        signature,
        wire: JSON.stringify({ signature, pda: m.delegationPda, amount: amount.toString(), buy: true }),
        lastValidBlockHeight: this.height + 150n,
      },
      amountIn: amount,
      minimumOut: (amount * this.price * 98n) / 100n,
      route: this.buyRoute,
      dammPool: this.dammPool,
    }
  }

  async bought(_m: Mandate, _b: Backing, signature: string): Promise<bigint | null> {
    return this.boughtBy.get(signature) ?? null
  }

  /** Every simulate() call, by signature. */
  simulations: string[] = []
  /** The next simulations to refuse, with these errors (then the send never happens). */
  simRefusals: { err: string; customCode: number | null }[] = []

  /** The program's clock (what transfers are checked against): nowS. */
  async clock(): Promise<bigint> {
    return this.nowS
  }

  async simulate(wire: string): Promise<{ err: string | null; customCode: number | null }> {
    const { signature } = JSON.parse(wire) as { signature: string }
    this.simulations.push(signature)
    return this.simRefusals.shift() ?? { err: null, customCode: null }
  }

  async send(wire: string): Promise<void> {
    const { signature, pda, amount, buy } = JSON.parse(wire) as {
      signature: string
      pda: string
      amount: string
      buy?: boolean
    }
    if (buy) {
      this.sends.push(signature)
      if (this.landed.has(signature)) return
      if (this.sendDrops > 0) {
        this.sendDrops--
        return
      }
      // Atomic: a swap that fails fails the transaction; the pull is undone with it. The code is
      // the program's: ExceededSlippage (6002) by default, or whatever swapFailureCode says.
      if (this.swapFailures > 0) {
        this.swapFailures--
        this.landed.set(signature, {
          signature,
          err: `{"InstructionError":[3,{"Custom":${this.swapFailureCode}}]}`,
          customCode: this.swapFailureCode,
          logs: [],
        })
        return
      }
      const pull = this.apply(signature, pda, BigInt(amount), 2)
      if (!pull.err) {
        this.delegateeQuote += BigInt(amount) // the pull lands in the executor's quote account…
        this.delegateeQuote -= BigInt(amount) // …and the exact-in swap spends all of it
        const out = BigInt(amount) * this.price
        this.backerBase += out
        this.boughtBy.set(signature, out)
        this.sent.push({ sig: signature, pda, amount: BigInt(amount) })
      }
      this.landed.set(signature, pull)
      return
    }
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

  async sendProof(wire: string): Promise<void> {
    this.proofSends.push((JSON.parse(wire) as { signature: string }).signature)
    const n = this.sends.length
    await this.send(wire)
    this.sends.length = n // a proof send, not a normal one
  }

  private apply(signature: string, pda: string, amount: bigint, ix = 0): Landed {
    const fail = (code: number | null, err: string): Landed => ({
      signature,
      err: err.replace('[0,', `[${ix},`),
      customCode: code,
      logs: [],
    })
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
