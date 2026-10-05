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
import type { Backing, Mandate, MandateStore, PullRow } from './mandate-store.js'
import {
  budgetInstructions,
  failedInstruction,
  PULL_INDEX,
  quoteDamm,
  quoteDbc,
  readLaunch,
  swapInstruction,
  SWAP_INDEX,
  type Route,
  type MeteoraConnection,
} from './meteora.js'
import type { Receipts } from './receipts.js'
import type { Logger } from './log.js'
import { safeError } from './log.js'
import {
  computeBudgetInstructions,
  latestBlockhash,
  PULL_BUDGET,
  sendOverCapProof,
  sendWire,
  simulateWire,
  signOnly,
  statusOf,
  type ComputeBudget,
  type Rpc,
  type SignedTx,
  type TxStatus,
} from './tx.js'

/** What the executor needs from the chain. The real one is `rpcChain`; tests use a simulated program. */
export interface ChainPort {
  read(pda: string): Promise<RecurringState>
  /** Receiver must exist, hold the mandate's mint, and belong to the payee. */
  receiverOk(m: Mandate): Promise<boolean>
  signPull(m: Mandate, amount: bigint): Promise<SignedTx>
  /**
   * Back permissions: one buy for this period — pull and swap in one signed transaction —
   * or why not now (the curve is migrating, or has nothing left to sell).
   */
  prepareBuy?(m: Mandate, b: Backing, amount: bigint): Promise<PreparedBuy>
  /** Back permissions: how much of the launch token a landed buy delivered to the backer. */
  bought?(m: Mandate, b: Backing, signature: string): Promise<bigint | null>
  /**
   * The program's clock: the Clock sysvar's unix time at 'confirmed', the bank every
   * simulation runs on. The period is the program's, so the executor reads it here rather
   * than trusting the server's wall clock, which runs ahead of it (mainnet, 6 Oct: the
   * confirmed block time was 1 to 2 s behind).
   */
  clock?(): Promise<bigint>
  /** Our own simulation of the signed bytes; every send but the over-cap demo runs it first. */
  simulate(wire: string): Promise<{ err: string | null; customCode: number | null }>
  /** Every normal send: the RPC node's preflight on, at 'confirmed' (tx.ts sendWire). */
  send(wire: string): Promise<void>
  /** The over-cap demo only: preflight off, so the refusal lands as proof (tx.ts sendOverCapProof). */
  sendProof(wire: string): Promise<void>
  status(signature: string, lastValidBlockHeight: bigint): Promise<TxStatus>
}

export type PreparedBuy =
  | { kind: 'buy'; signed: SignedTx; amountIn: bigint; minimumOut: bigint; route: Route; dammPool: string | null }
  | { kind: 'wait'; reason: 'migrating' | 'nothing_left' }

const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111' as Address
/** When the program's clock cannot be read, the wall clock less this margin stands in for it. */
export const CLOCK_MARGIN_S = 5n

export function rpcChain(
  rpc: Rpc,
  delegatee: TransactionSigner,
  budget: ComputeBudget = PULL_BUDGET,
  conn?: MeteoraConnection,
): ChainPort {
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
      return signOnly(delegatee, [...computeBudgetInstructions(budget), ix], await latestBlockhash(rpc))
    },
    async prepareBuy(m, b, amount) {
      if (!conn) throw new Error('back permissions need a web3 connection')
      const L = await readLaunch(conn, b.pool, b.dammPool)
      if (L.quoteMint !== m.mint) throw new Error('the launch is not priced in this permission’s token')
      if (L.route === 'migrating' || !L.swap) return { kind: 'wait', reason: 'migrating' }
      const nowS = Math.floor(Date.now() / 1000)
      const slot = await conn.getSlot('confirmed')
      const q =
        L.route === 'dbc'
          ? quoteDbc(L.raw.dbc!.pool, L.raw.dbc!.config, amount, b.slippageBps, nowS, slot)
          : quoteDamm(conn, L.raw.damm!, L.quoteMint, amount, b.slippageBps, nowS, slot)
      if (q.kind === 'wait') return q
      const pull = await pullInstruction({
        delegatee,
        delegationPda: m.delegationPda as Address,
        delegator: m.address as Address,
        delegatorAta: m.userAta as Address,
        receiverAta: m.receiverAta as Address, // the executor's own quote account, emptied by the swap
        mint: m.mint as Address,
        amount: q.amountIn,
      })
      const swap = await swapInstruction(conn, L.swap, {
        delegatee: delegatee.address,
        backerBaseAta: b.backerBaseAta,
        amountIn: q.amountIn,
        minimumOut: q.minimumOut,
      })
      const signed = await signOnly(delegatee, [...budgetInstructions(), pull, swap], await latestBlockhash(rpc))
      return {
        kind: 'buy',
        signed,
        amountIn: q.amountIn,
        minimumOut: q.minimumOut,
        route: L.route,
        dammPool: L.dammPool,
      }
    },
    async bought(m, b, signature) {
      const tx = (await rpc
        .getTransaction(signature as never, {
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
          commitment: 'confirmed',
        })
        .send()) as unknown as { meta?: { preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } } | null
      const pick = (xs?: TokenBal[]) =>
        xs?.find((x) => x.mint === b.baseMint && x.owner === m.address)?.uiTokenAmount.amount
      const after = pick(tx?.meta?.postTokenBalances)
      if (after === undefined) return null
      return BigInt(after) - BigInt(pick(tx?.meta?.preTokenBalances) ?? '0')
    },
    async clock() {
      const { value } = await rpc.getAccountInfo(CLOCK_SYSVAR, { encoding: 'base64', commitment: 'confirmed' }).send()
      if (!value) throw new Error('no clock sysvar')
      const data = Buffer.from(value.data[0] as string, 'base64')
      // Clock: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64.
      return data.readBigInt64LE(32)
    },
    simulate: (wire) => simulateWire(rpc, wire),
    send: (wire) => sendWire(rpc, wire),
    sendProof: (wire) => sendOverCapProof(rpc, wire),
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
  /**
   * While a just-sent pull is pending, the same signed bytes are sent again this
   * often. A mainnet send can be dropped (30 Sep: the first pull's transaction
   * never landed and was replaced only after its blockhash expired, 40 s later).
   * Identical bytes carry the same signature, so a rebroadcast cannot pay twice.
   */
  rebroadcastMs?: number
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
  | 'buy_waiting'
  | 'skipped'

export class Executor {
  private readonly o: Required<Omit<ExecutorOptions, 'store' | 'chain' | 'receipts' | 'log'>> &
    Pick<ExecutorOptions, 'store' | 'chain' | 'receipts' | 'log'>
  private readonly backoff = new Map<string, { failures: number; nextAt: number }>()
  /** The program's clock as read at the start of this tick (null: not read yet). */
  private chainNowS: bigint | null = null
  private running = false
  private again = false

  constructor(options: ExecutorOptions) {
    this.o = {
      now: Date.now,
      maxAttempts: 3,
      backoffBaseMs: 5_000,
      backoffMaxMs: 10 * 60_000,
      settleMs: 20_000,
      rebroadcastMs: 2_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
      ...options,
    }
  }

  /** One pass over every active mandate. Never throws; never overlaps itself. */
  /**
   * Runs a tick now rather than at the next interval: a permission confirmed on
   * chain gets its first pull right away. A kick during a tick runs one more.
   */
  kick(): void {
    if (this.running) {
      this.again = true
      return
    }
    void this.tick()
  }

  async tick(): Promise<Record<string, Outcome>> {
    const out: Record<string, Outcome> = {}
    if (this.running) return out
    this.running = true
    try {
      this.chainNowS = await this.readClock()
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
      if (this.again) {
        this.again = false
        setTimeout(() => void this.tick(), 0)
      }
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

  /**
   * Seconds since the epoch on the program's clock, which decides every period. A failed
   * read falls back to the wall clock less CLOCK_MARGIN_S: late by a few seconds rather
   * than early, because early claims a period the program has not opened yet.
   */
  private async readClock(): Promise<bigint> {
    const wall = BigInt(Math.floor(this.o.now() / 1000))
    if (!this.o.chain.clock) return wall
    try {
      return await this.o.chain.clock()
    } catch (e) {
      this.o.log.warn('executor_clock_unread', { error: safeError(e) })
      return wall - CLOCK_MARGIN_S
    }
  }
  private nowS(): bigint {
    return this.chainNowS ?? BigInt(Math.floor(this.o.now() / 1000))
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

    // The program's clock, not the wall clock: a tick that runs ahead of the chain would claim a
    // period the program has not opened, and its pull would be refused (0x190) and lost.
    const nowS = this.nowS()
    const w = effectiveWindow(state, nowS)
    if (w.expired) return this.end(m, 'expired')
    if (w.periodIndex < 0n) return 'not_started'
    const periodStart = Number(w.periodStart)

    const back = this.o.store.backingOf(m.id)
    const existing = this.o.store.getPull(m.delegationPda, periodStart)
    if (existing) {
      if (existing.state === 'skipped' && back) return this.retryBuy(m, back, existing, w.remaining)
      if (existing.state !== 'signed') return 'period_done'
      return this.resolve(m, existing)
    }
    // A buy is sent at a jittered moment inside its period, not at the boundary, so its
    // timing is not a free signal for anyone wanting to trade ahead of it.
    if (back && Number(nowS) < periodStart + buyJitterS(m.id, periodStart, m.periodLengthS)) return 'not_started'

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

    let signed: SignedTx
    let claimAmount = amount
    if (back) {
      const p = await this.prepareBuy(m, back, amount)
      if (p.kind === 'wait') return 'buy_waiting'
      signed = p.signed
      claimAmount = p.amountIn
    } else signed = await this.o.chain.signPull(m, amount)
    const claimed = this.o.store.claimPull(
      {
        mandateId: m.id,
        delegationPda: m.delegationPda,
        periodStart,
        amount: claimAmount.toString(),
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
    const row = this.o.store.getPull(m.delegationPda, periodStart)!
    const refused = await this.sendChecked(m, row, signed.wire)
    if (refused) return refused
    return this.settle(m, row, signed.wire)
  }

  /**
   * Polls a just-sent pull for up to settleMs so the receipt arrives promptly,
   * rebroadcasting the same signed bytes while it is pending.
   */
  private async settle(m: Mandate, row: PullRow, wire?: string): Promise<Outcome> {
    const deadline = this.o.now() + this.o.settleMs
    let lastSent = this.o.now()
    for (;;) {
      const outcome = await this.resolve(m, row)
      if (outcome !== 'sent_pending' || this.o.now() >= deadline) return outcome
      if (wire && this.o.now() - lastSent >= this.o.rebroadcastMs) {
        lastSent = this.o.now()
        await this.o.chain.send(wire).catch(() => {}) // a failed rebroadcast is just another try later
      }
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
      const back = this.o.store.backingOf(m.id)
      let signed: SignedTx
      let amount: string | undefined
      if (back) {
        // A fresh quote: the old one is as stale as the blockhash.
        const p = await this.prepareBuy(m, back, BigInt(row.amount))
        if (p.kind === 'wait') {
          this.o.store.finishPull(row.id, 'skipped', null, `buy_${p.reason}`, this.o.now())
          return 'buy_waiting'
        }
        signed = p.signed
        amount = p.amountIn.toString()
      } else signed = await this.o.chain.signPull(m, BigInt(row.amount))
      this.o.store.reattemptPull(row.id, signed.signature, signed.lastValidBlockHeight.toString(), this.o.now(), amount)
      this.o.log.warn('executor_reattempt', {
        mandate: m.id,
        old: row.signature,
        sig: signed.signature,
        attempt: row.attempts + 1,
      })
      const again = this.o.store.getPull(m.delegationPda, row.periodStart)!
      const refused = await this.sendChecked(m, again, signed.wire)
      if (refused) return refused
      return this.settle(m, again, signed.wire)
    }

    const landed = st.landed
    const back = this.o.store.backingOf(m.id)
    if (!landed.err) {
      this.o.store.finishPull(row.id, 'landed', null, null, this.o.now())
      const after = await this.o.chain.read(m.delegationPda)
      const w = after.exists ? effectiveWindow(after, this.nowS()) : null
      const got = back ? await this.o.chain.bought?.(m, back, landed.signature).catch(() => null) : null
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
          ...(back
            ? {
                kind: 'buy' as const,
                outBaseUnits: got == null ? null : got.toString(),
                outDecimals: back.baseDecimals,
                outSymbol: back.baseSymbol,
              }
            : {}),
        },
        {
          remainingBaseUnits: w?.remaining,
          capBaseUnits: BigInt(m.amountPerPeriod),
          nextResetTs: w ? Number(w.nextResetTs) : undefined,
          periodLengthS: m.periodLengthS,
        },
      )
      return 'landed'
    }

    // A buy whose swap missed its minimum-out: the whole transaction failed, so nothing was
    // pulled. One receipt per period; tried again later in the period with a fresh quote.
    if (back && failedInstruction(landed.err) === SWAP_INDEX) return this.skipBuy(m, back, row, landed.customCode)

    if (landed.customCode === ERR.AmountExceedsPeriodLimit && (!back || failedInstruction(landed.err) === PULL_INDEX)) {
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

  /** Compose and sign a buy; the route follows the token and is remembered when it moves. */
  private async prepareBuy(m: Mandate, b: Backing, amount: bigint): Promise<PreparedBuy> {
    if (!this.o.chain.prepareBuy) throw new Error('this chain port cannot buy')
    const p = await this.o.chain.prepareBuy(m, b, amount)
    if (p.kind === 'buy' && (p.route !== b.route || p.dammPool !== b.dammPool)) {
      this.o.store.setRoute(m.id, p.route, p.dammPool)
      this.o.log.info('executor_route_switch', {
        mandate: m.id,
        from: b.route,
        to: p.route,
        pool: p.dammPool ?? b.pool,
      })
    }
    if (p.kind === 'wait') this.o.log.info('executor_buy_waiting', { mandate: m.id, pool: b.pool, reason: p.reason })
    return p
  }

  /** A skipped buy, tried again later in its period with a fresh quote, up to maxAttempts. */
  private async retryBuy(m: Mandate, b: Backing, row: PullRow, remaining: bigint): Promise<Outcome> {
    if (row.attempts >= this.o.maxAttempts) return 'period_done'
    if (this.o.now() < row.nextAttemptAt) return 'skipped'
    const amount = BigInt(m.pullAmount) < remaining ? BigInt(m.pullAmount) : remaining
    if (amount <= 0n) return 'period_done'
    const p = await this.prepareBuy(m, b, amount)
    if (p.kind === 'wait') return 'buy_waiting'
    this.o.store.reattemptPull(
      row.id,
      p.signed.signature,
      p.signed.lastValidBlockHeight.toString(),
      this.o.now(),
      p.amountIn.toString(),
    )
    this.o.log.info('executor_buy_retry', { mandate: m.id, sig: p.signed.signature, attempt: row.attempts + 1 })
    const again = this.o.store.getPull(m.delegationPda, row.periodStart)!
    const refused = await this.sendChecked(m, again, p.signed.wire)
    if (refused) return refused
    return this.settle(m, again, p.signed.wire)
  }

  /**
   * A buy whose swap would miss (simulated) or missed (landed) its minimum-out: nothing
   * was pulled. One receipt per period; tried again later in the period with a fresh quote.
   */
  private async skipBuy(m: Mandate, back: Backing, row: PullRow, customCode: number | null): Promise<Outcome> {
    this.o.store.finishPull(row.id, 'skipped', customCode, 'swap_minimum_out', this.o.now())
    const delay = Math.min(this.o.backoffBaseMs * 2 ** row.attempts, this.o.backoffMaxMs)
    this.o.store.backoffPull(
      row.id,
      this.o.now() + Math.round(delay * (0.5 + this.o.random() / 2)),
      'swap_minimum_out',
      this.o.now(),
    )
    await this.o.receipts.emit(
      m.address,
      {
        kind: 'skipped',
        at: this.o.now(),
        delegationPda: m.delegationPda,
        delegatee: m.delegatee,
        label: m.label || null,
        amountBaseUnits: row.amount,
        decimals: m.decimals,
        symbol: m.symbol,
        signature: `skipped:${m.delegationPda}:${row.periodStart}`,
        actor: 'nuntius',
      },
      { slippagePct: back.slippageBps / 100 },
    )
    return 'skipped'
  }

  /**
   * Our own simulation, then the send. A transaction the program would refuse is never
   * sent: a buy whose swap would miss becomes the same skip as a landed miss, and anything
   * else is recorded as refused before it costs a fee. null = sent, settle it.
   */
  private async sendChecked(m: Mandate, row: PullRow, wire: string): Promise<Outcome | null> {
    const sim = await this.o.chain.simulate(wire)
    if (!sim.err) {
      await this.o.chain.send(wire)
      return null
    }
    const back = this.o.store.backingOf(m.id)
    this.o.log.warn('executor_simulation_refused', { mandate: m.id, sig: row.signature, err: sim.err })
    if (back && failedInstruction(sim.err) === SWAP_INDEX) return this.skipBuy(m, back, row, sim.customCode)
    this.o.store.finishPull(row.id, 'refused', sim.customCode, `simulated: ${sim.err}`.slice(0, 200), this.o.now())
    return 'refused'
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
      { capBaseUnits: BigInt(m.amountPerPeriod), periodLengthS: m.periodLengthS },
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
    const w = effectiveWindow(state, await this.readClock())
    const signed = await this.o.chain.signPull(m, w.remaining + 1n)
    // The one send without our simulation and without the RPC node's preflight, on purpose:
    // both would refuse it, and the refusal must land on chain with a signature to be the
    // 0x190 proof.
    await this.o.chain.sendProof(signed.wire)
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

interface TokenBal {
  mint: string
  owner?: string
  uiTokenAmount: { amount: string }
}

/**
 * Seconds after a period starts before its buy is sent: up to a tenth of the period, at
 * most 10 minutes. Fixed per (permission, period), so every tick agrees on it.
 */
export function buyJitterS(mandateId: string, periodStart: number, periodLengthS: number): number {
  let h = 2166136261
  for (const c of `${mandateId}:${periodStart}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  const span = Math.min(Math.floor(periodLengthS / 10), 600)
  return span > 0 ? h % span : 0
}

/** Runs tick() on an interval. Returns stop(). */
export function startExecutor(executor: Executor, intervalMs: number): () => void {
  const handle = setInterval(() => void executor.tick(), intervalMs)
  return () => clearInterval(handle)
}
