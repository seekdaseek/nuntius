/**
 * The executor: pulls each active mandate once per period, while the phone
 * stays in a pocket. Hardened for the four ways money code goes wrong:
 *
 * 1. Doubles. A pull is keyed by (delegation, period start) in a UNIQUE ledger
 *    row that holds the signature BEFORE it is sent. A replacement transaction
 *    is only built once the previous one's blockhash is provably dead, so two
 *    live transfers for one period never exist. The chain's per-period cap is
 *    the backstop if this code is wrong anyway.
 * 2. Flaky RPC. A thrown error backs the mandate off exponentially with
 *    jitter; nothing is marked failed for a transport error.
 * 3. The chain says no. 0x190 is a clean refusal: ledger row `refused`, a
 *    receipt recorded and pushed, never retried. Other program errors are
 *    deterministic and are not retried either.
 * 4. The user left. A delegation that no longer exists was revoked; one past
 *    expiry is over. Both end the mandate with a receipt, and the executor
 *    stops touching it.
 *
 * Logs are JSON through log.ts's redactor: signatures and addresses, never keys.
 *
 * Not built (single-process scope, documented in SECURITY.md): leader election
 * beyond the SQLite UNIQUE claim, KMS custody of the delegatee key, fee
 * top-up monitoring.
 */
import type { Address, TransactionSigner } from '@solana/kit'
import { effectiveWindow, ERR, pullInstruction, readAta, readRecurring, type RecurringState } from './mandate-chain.js'
import type { Mandate, MandateStore, PullRow } from './mandate-store.js'
import type { Receipts } from './receipts.js'
import type { Logger } from './log.js'
import { safeError } from './log.js'
import { latestBlockhash, sendWire, signOnly, statusOf, type Rpc, type SignedTx, type TxStatus } from './tx.js'

/** What the executor needs from the chain. The real one is `rpcChain`; tests use a simulated program. */
export interface ChainPort {
  read(pda: string): Promise<RecurringState>
  /** Receiver must exist, hold the mandate's mint, and belong to the payee. */
  receiverOk(m: Mandate): Promise<boolean>
  signPull(m: Mandate, amount: bigint): Promise<SignedTx>
  send(wire: string): Promise<void>
  status(signature: string, lastValidBlockHeight: bigint): Promise<TxStatus>
}

export function rpcChain(rpc: Rpc, delegatee: TransactionSigner): ChainPort {
  return {
    read: (pda) => readRecurring(rpc, pda as Address),
    async receiverOk(m) {
      const a = await readAta(rpc, m.receiverAta as Address)
      return a.exists && a.mint === m.mint && a.owner === m.payee
    },
    async signPull(m, amount) {
      const ix = await pullInstruction({
        delegatee,
        delegationPda: m.delegationPda as Address,
        delegator: m.address as Address,
        delegatorAta: m.userAta as Address,
        receiverAta: m.receiverAta as Address,
        mint: m.mint as Address,
        amount,
      })
      return signOnly(delegatee, [ix], await latestBlockhash(rpc))
    },
    send: (wire) => sendWire(rpc, wire),
    status: (sig, lvbh) => statusOf(rpc, sig, lvbh),
  }
}

export interface ExecutorOptions {
  store: MandateStore
  chain: ChainPort
  receipts: Receipts
  log: Logger
  now?: () => number
  /** Max transactions per period (one original + replacements after expiry). */
  maxAttempts?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** How long a tick waits for a just-sent pull to land before leaving it to the next tick. */
  settleMs?: number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export type Outcome =
  | 'skipped_backoff'
  | 'revoked'
  | 'expired'
  | 'not_started'
  | 'period_done'
  | 'cap_already_used'
  | 'receiver_invalid'
  | 'terms_mismatch'
  | 'sent_pending'
  | 'landed'
  | 'refused'
  | 'failed'
  | 'claimed_elsewhere'
  | 'error'

export class Executor {
  private readonly o: Required<Omit<ExecutorOptions, 'store' | 'chain' | 'receipts' | 'log'>> &
    Pick<ExecutorOptions, 'store' | 'chain' | 'receipts' | 'log'>
  private readonly backoff = new Map<string, { failures: number; nextAt: number }>()
  private running = false

  constructor(options: ExecutorOptions) {
    this.o = {
      now: Date.now,
      maxAttempts: 3,
      backoffBaseMs: 5_000,
      backoffMaxMs: 10 * 60_000,
      settleMs: 20_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
      ...options,
    }
  }

  /** One pass over every active mandate. Never throws; never overlaps itself. */
  async tick(): Promise<Record<string, Outcome>> {
    const out: Record<string, Outcome> = {}
    if (this.running) return out
    this.running = true
    try {
      for (const m of this.o.store.activeMandates()) {
        try {
          out[m.id] = await this.processMandate(m)
          if (out[m.id] !== 'skipped_backoff') this.backoff.delete(m.id)
        } catch (e) {
          out[m.id] = 'error'
          this.fail(m, e)
        }
      }
    } finally {
      this.running = false
    }
    return out
  }

  private fail(m: Mandate, e: unknown): void {
    const prev = this.backoff.get(m.id)?.failures ?? 0
    const failures = prev + 1
    const exp = Math.min(this.o.backoffBaseMs * 2 ** (failures - 1), this.o.backoffMaxMs)
    const delay = Math.round(exp * (0.5 + this.o.random() / 2)) // full jitter in [exp/2, exp]
    this.backoff.set(m.id, { failures, nextAt: this.o.now() + delay })
    this.o.log.warn('executor_backoff', {
      mandate: m.id,
      pda: m.delegationPda,
      failures,
      delayMs: delay,
      error: safeError(e),
    })
  }

  /** Visible for tests. */
  backoffOf(id: string): { failures: number; nextAt: number } | undefined {
    return this.backoff.get(id)
  }

  private async processMandate(m: Mandate): Promise<Outcome> {
    const b = this.backoff.get(m.id)
    if (b && b.nextAt > this.o.now()) return 'skipped_backoff'

    const state = await this.o.chain.read(m.delegationPda)
    if (!state.exists) return this.end(m, 'revoked')
    if (
      state.delegatee !== m.delegatee ||
      state.amountPerPeriod !== BigInt(m.amountPerPeriod) ||
      state.periodLengthS !== BigInt(m.periodLengthS)
    ) {
      this.o.log.error('executor_terms_mismatch', { mandate: m.id, pda: m.delegationPda })
      return 'terms_mismatch'
    }

    const nowS = BigInt(Math.floor(this.o.now() / 1000))
    const w = effectiveWindow(state, nowS)
    if (w.expired) return this.end(m, 'expired')
    if (w.periodIndex < 0n) return 'not_started'
    const periodStart = Number(w.periodStart)

    const existing = this.o.store.getPull(m.delegationPda, periodStart)
    if (existing) {
      if (existing.state !== 'signed') return 'period_done'
      return this.resolve(m, existing)
    }

    const amount = BigInt(m.pullAmount)
    if (w.remaining < amount) {
      // Only our delegatee can pull this delegation, so this means the period was
      // already used through another path (e.g. a demo pull). Sending would only
      // buy a refusal we already know about.
      this.o.log.info('executor_cap_already_used', { mandate: m.id, remaining: w.remaining, amount })
      return 'cap_already_used'
    }
    if (!(await this.o.chain.receiverOk(m))) {
      this.o.log.error('executor_receiver_invalid', { mandate: m.id, receiver: m.receiverAta })
      throw new Error('receiver account missing or not the payee’s account for this mint')
    }

    const signed = await this.o.chain.signPull(m, amount)
    const claimed = this.o.store.claimPull(
      {
        mandateId: m.id,
        delegationPda: m.delegationPda,
        periodStart,
        amount: amount.toString(),
        signature: signed.signature,
        lastValidBlockHeight: signed.lastValidBlockHeight.toString(),
      },
      this.o.now(),
    )
    if (!claimed) return 'claimed_elsewhere'
    this.o.log.info('executor_send', {
      mandate: m.id,
      pda: m.delegationPda,
      periodStart,
      amount,
      sig: signed.signature,
    })
    await this.o.chain.send(signed.wire)
    const row = this.o.store.getPull(m.delegationPda, periodStart)!
    return this.settle(m, row)
  }

  /** Polls a just-sent pull for up to settleMs so the receipt arrives promptly. */
  private async settle(m: Mandate, row: PullRow): Promise<Outcome> {
    const deadline = this.o.now() + this.o.settleMs
    for (;;) {
      const outcome = await this.resolve(m, row)
      if (outcome !== 'sent_pending' || this.o.now() >= deadline) return outcome
      await this.o.sleep(500)
      row = this.o.store.getPull(m.delegationPda, row.periodStart)!
    }
  }

  private async resolve(m: Mandate, row: PullRow): Promise<Outcome> {
    const st = await this.o.chain.status(row.signature, BigInt(row.lastValidBlockHeight))
    if (st.state === 'pending') return 'sent_pending'

    if (st.state === 'expired') {
      // The old blockhash can no longer land, so a replacement cannot double-pull.
      if (row.attempts >= this.o.maxAttempts) {
        this.o.store.finishPull(row.id, 'failed', null, 'expired_max_attempts', this.o.now())
        this.o.log.error('executor_gave_up', { mandate: m.id, periodStart: row.periodStart, attempts: row.attempts })
        return 'failed'
      }
      const signed = await this.o.chain.signPull(m, BigInt(row.amount))
      this.o.store.reattemptPull(row.id, signed.signature, signed.lastValidBlockHeight.toString(), this.o.now())
      this.o.log.warn('executor_reattempt', {
        mandate: m.id,
        old: row.signature,
        sig: signed.signature,
        attempt: row.attempts + 1,
      })
      await this.o.chain.send(signed.wire)
      return this.settle(m, this.o.store.getPull(m.delegationPda, row.periodStart)!)
    }

    const landed = st.landed
    if (!landed.err) {
      this.o.store.finishPull(row.id, 'landed', null, null, this.o.now())
      const after = await this.o.chain.read(m.delegationPda)
      const w = after.exists ? effectiveWindow(after, BigInt(Math.floor(this.o.now() / 1000))) : null
      await this.o.receipts.emit(
        m.address,
        {
          kind: 'pull',
          at: this.o.now(),
          delegationPda: m.delegationPda,
          delegatee: m.delegatee,
          label: m.label || null,
          amountBaseUnits: row.amount,
          decimals: m.decimals,
          symbol: m.symbol,
          signature: landed.signature,
          actor: 'nuntius',
        },
        {
          remainingBaseUnits: w?.remaining,
          capBaseUnits: BigInt(m.amountPerPeriod),
          nextResetTs: w ? Number(w.nextResetTs) : undefined,
        },
      )
      return 'landed'
    }

    if (landed.customCode === ERR.AmountExceedsPeriodLimit) {
      this.o.store.finishPull(row.id, 'refused', landed.customCode, 'AmountExceedsPeriodLimit', this.o.now())
      await this.refusalReceipt(m, landed.signature, BigInt(row.amount))
      return 'refused'
    }
    if (landed.customCode === ERR.DelegationExpired) {
      this.o.store.finishPull(row.id, 'failed', landed.customCode, 'DelegationExpired', this.o.now())
      return this.end(m, 'expired')
    }
    // Any other on-chain error is deterministic: record it, do not retry, and
    // check whether the delegation is simply gone.
    this.o.store.finishPull(row.id, 'failed', landed.customCode, landed.err, this.o.now())
    this.o.log.error('executor_pull_failed', { mandate: m.id, sig: landed.signature, err: landed.err })
    const still = await this.o.chain.read(m.delegationPda)
    if (!still.exists) return this.end(m, 'revoked')
    return 'failed'
  }

  private async refusalReceipt(m: Mandate, signature: string, amount: bigint): Promise<void> {
    await this.o.receipts.emit(
      m.address,
      {
        kind: 'refused',
        at: this.o.now(),
        delegationPda: m.delegationPda,
        delegatee: m.delegatee,
        label: m.label || null,
        amountBaseUnits: amount.toString(),
        decimals: m.decimals,
        symbol: m.symbol,
        signature,
        actor: 'nuntius',
      },
      { capBaseUnits: BigInt(m.amountPerPeriod) },
    )
  }

  private async end(m: Mandate, kind: 'revoked' | 'expired'): Promise<Outcome> {
    this.o.store.setStatus(m.id, kind, this.o.now())
    this.o.log.info('executor_mandate_ended', { mandate: m.id, pda: m.delegationPda, kind })
    await this.o.receipts.emit(m.address, {
      kind,
      at: this.o.now(),
      delegationPda: m.delegationPda,
      delegatee: m.delegatee,
      label: m.label || null,
      amountBaseUnits: null,
      decimals: m.decimals,
      symbol: m.symbol,
      // One end-of-life receipt per mandate: key it on the PDA.
      signature: `${kind}:${m.delegationPda}`,
      actor: 'nuntius',
    })
    return kind
  }

  /**
   * Demo only (enabled by config): asks the chain for one base unit more than
   * is left this period, so the refusal lands as a real transaction and the
   * phone gets the "refused by the chain" receipt. Outside the ledger: it is
   * not a scheduled pull.
   */
  async demoOverCap(m: Mandate): Promise<{ signature: string; customCode: number | null }> {
    const state = await this.o.chain.read(m.delegationPda)
    if (!state.exists) throw new Error('delegation does not exist')
    const w = effectiveWindow(state, BigInt(Math.floor(this.o.now() / 1000)))
    const signed = await this.o.chain.signPull(m, w.remaining + 1n)
    await this.o.chain.send(signed.wire)
    const deadline = this.o.now() + this.o.settleMs
    for (;;) {
      const st = await this.o.chain.status(signed.signature, signed.lastValidBlockHeight)
      if (st.state === 'landed') {
        if (st.landed.customCode === ERR.AmountExceedsPeriodLimit) {
          await this.refusalReceipt(m, st.landed.signature, w.remaining + 1n)
        }
        return { signature: st.landed.signature, customCode: st.landed.customCode }
      }
      if (st.state === 'expired' || this.o.now() >= deadline) throw new Error('demo pull did not land')
      await this.o.sleep(500)
    }
  }
}

/** Runs tick() on an interval. Returns stop(). */
export function startExecutor(executor: Executor, intervalMs: number): () => void {
  const handle = setInterval(() => void executor.tick(), intervalMs)
  return () => clearInterval(handle)
}
