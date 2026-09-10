/**
 * Spike executor: something has to call the program on schedule.
 *
 * A single in-process timer is deliberately the whole implementation — enough to
 * prove the mechanic, and honest about being a spike. What production needs is
 * documented at the bottom of this file rather than half-built here.
 */
import type { Address, TransactionSigner } from '@solana/kit'
import type { Store } from './db.js'
import type { FcmSender } from './fcm.js'
import { ensureReceiverAta, executePull, readDelegation } from './delegation.js'

export interface ExecutorOptions {
  rpcUrl: string
  store: Store
  fcm: FcmSender | null
  payer: TransactionSigner
  delegatee: TransactionSigner
  /** Wallets whose delegations this executor drives. */
  addresses: () => string[]
  intervalMs: number
  decimals: number
}

/** Starts the timer; returns a stop function. */
export function startExecutor(options: ExecutorOptions): () => void {
  const { rpcUrl, store, fcm, payer, delegatee, addresses, intervalMs, decimals } = options
  const unit = 10n ** BigInt(decimals)
  let running = false

  async function tick(): Promise<void> {
    // Never overlap runs: a slow RPC must not stack pulls on the same delegation.
    if (running) return
    running = true
    try {
      for (const address of addresses()) {
        const row = store.getDelegation(address)
        if (!row) continue
        const state = await readDelegation(rpcUrl, row.delegationPda as Address)
        if (!state.exists || !state.amountPerPeriod || !state.amountPulledInPeriod) continue

        const cap = BigInt(state.amountPerPeriod)
        const used = BigInt(state.amountPulledInPeriod)
        const remaining = cap - used
        // Fire once per period: if this period's cap is spent, wait for the roll.
        if (remaining <= 0n) continue

        const amount = remaining
        const receiverAta =
          row.receiverAta ??
          (await ensureReceiverAta({ rpcUrl, payer, mint: row.mint as Address, owner: delegatee.address }))
        if (!row.receiverAta) store.setReceiverAta(row.delegationPda, receiverAta)

        const signature = await executePull({
          rpcUrl,
          delegatee,
          delegationPda: row.delegationPda as Address,
          delegator: row.address as Address,
          delegatorAta: row.userAta as Address,
          receiverAta: receiverAta as Address,
          mint: row.mint as Address,
          amount,
        })

        const after = await readDelegation(rpcUrl, row.delegationPda as Address)
        const left =
          after.amountPerPeriod && after.amountPulledInPeriod
            ? BigInt(after.amountPerPeriod) - BigInt(after.amountPulledInPeriod)
            : 0n
        const nextReset = (after.currentPeriodStartTs ?? 0) + (after.periodLengthS ?? 0)
        console.log(`executor: pulled ${amount / unit} for ${address} — ${signature}`)

        if (fcm) {
          const url =
            `/alert?source=delegation&sig=${signature}&moved=${amount / unit}` +
            `&remaining=${left / unit}&reset=${nextReset}&pda=${row.delegationPda}`
          for (const token of store.getPushTokens(address)) {
            await fcm.send(
              token,
              {
                title: 'Delegated transfer executed',
                body: `${amount / unit} tokens moved. ${left / unit} left this period.`,
              },
              'alerts',
              { url, channelId: 'alerts' },
            )
          }
        }
      }
    } catch (error) {
      // A failing tick must never kill the timer.
      console.log(`executor tick failed: ${error instanceof Error ? error.message : 'unknown'}`)
    } finally {
      running = false
    }
  }

  const handle = setInterval(() => void tick(), intervalMs)
  return () => clearInterval(handle)
}

/**
 * What production would need instead of the above, and roughly what it costs:
 *
 * - Durability. This timer dies with the process and forgets in-flight work. A
 *   real executor needs a persisted job queue with at-least-once delivery and an
 *   idempotency key per (delegation, period) so a retry cannot double-pull.
 * - Leader election. Two instances running this loop would both pull. Either a
 *   single-writer lock (Postgres advisory lock, Redis lease) or a queue whose
 *   consumers are exclusive per delegation.
 * - Fee funding. The delegatee pays every pull's transaction fee, so it needs a
 *   monitored, auto-topped-up balance. At ~5,000 lamports a signature, 10,000
 *   pulls/day is ~0.05 SOL/day — trivial in SOL, but a hard outage when it hits
 *   zero, which is exactly how this spike first failed.
 * - Key custody. The delegatee key can pull from every user who delegated to it.
 *   It belongs in a KMS/HSM with a signing service, not a file on disk like the
 *   spike's delegatee.json. Its blast radius is capped by the program (per-period
 *   limits, user revocation) but not by us.
 * - Scheduling accuracy. Periods roll lazily on chain, so the executor must
 *   compute the period itself rather than trusting amountPulledInPeriod, and
 *   should schedule against currentPeriodStartTs + periodLengthS rather than a
 *   fixed interval that drifts.
 * - Observability. Per-pull outcome, cap-exhausted vs failed vs revoked, and an
 *   alert when a delegation starts failing — a silently dead executor looks
 *   identical to a user who simply stopped spending.
 */
