/**
 * The token-level cap. `initSubscriptionAuthority` approves the authority PDA
 * for u64::MAX on the user's token account, which wallets show as "Unlimited".
 * nuntius follows it, in the same transaction, with an SPL `approveChecked`
 * that sets the allowance to the most every live delegation on that mint can
 * still take over its whole life. Each pull through the program spends from
 * that allowance, so the token program itself then refuses anything beyond it.
 *
 * The period arithmetic mirrors program/src/instructions/helpers/transfer_validation.rs
 * (release 364a419): a period is billable when it starts strictly before
 * `expiry_ts`, a transfer is refused once `current_ts > expiry_ts`, and the
 * stored `amount_pulled_in_period` belongs to the stored period start only.
 */
import type { DelegationView } from './mandate-chain.js'

/** Billable period starts from `from` (a period start) up to, not including, expiry. */
function periodsFrom(from: bigint, len: bigint, expiry: bigint): bigint {
  if (expiry <= from) return 0n
  return (expiry - from + len - 1n) / len
}

/**
 * What a recurring delegation can still move over its whole life, at `nowS`.
 * `null` when it has no expiry: then no finite allowance is safe.
 */
export function recurringLifetime(
  d: {
    amountPerPeriod: bigint
    amountPulledInPeriod: bigint
    currentPeriodStartTs: bigint
    periodLengthS: bigint
    expiryTs: bigint
  },
  nowS: bigint,
): bigint | null {
  const {
    amountPerPeriod: cap,
    amountPulledInPeriod: pulled,
    currentPeriodStartTs: start,
    periodLengthS: len,
    expiryTs: expiry,
  } = d
  if (expiry === 0n) return null
  if (len <= 0n) return 0n
  if (nowS > expiry) return 0n
  if (start >= expiry) return 0n
  // The period the program would bill now: the stored start rolled forward in
  // whole periods, but never past the last billable start before expiry.
  const lastIndex = (expiry - 1n - start) / len
  const elapsed = nowS > start ? (nowS - start) / len : 0n
  const index = elapsed < lastIndex ? elapsed : lastIndex
  const current = start + index * len
  const periods = periodsFrom(current, len, expiry)
  const usedNow = index === 0n ? pulled : 0n
  const total = cap * periods - (usedNow < cap ? usedNow : cap)
  return total > 0n ? total : 0n
}

/** The same for a new grant that starts when its transaction lands (about `nowS`). */
export function newGrantLifetime(
  amountPerPeriod: bigint,
  periodLengthS: bigint,
  startTs: bigint,
  expiryTs: bigint,
  nowS: bigint,
): bigint | null {
  if (expiryTs === 0n) return null
  const start = startTs > 0n ? startTs : nowS
  return amountPerPeriod * periodsFrom(start, periodLengthS, expiryTs)
}

/** What any live delegation, of any delegatee, can still take from this mint. `null` = unbounded. */
export function delegationLifetime(d: DelegationView, nowS: bigint): bigint | null {
  switch (d.kind) {
    case 'recurring':
      return recurringLifetime(
        {
          amountPerPeriod: BigInt(d.amountPerPeriod ?? '0'),
          amountPulledInPeriod: BigInt(d.amountPulledInPeriod ?? '0'),
          currentPeriodStartTs: BigInt(d.currentPeriodStartTs ?? 0),
          periodLengthS: BigInt(d.periodLengthS ?? 0),
          expiryTs: BigInt(d.expiryTs ?? 0),
        },
        nowS,
      )
    case 'fixed': {
      const expiry = BigInt(d.expiryTs ?? 0)
      if (expiry > 0n && nowS > expiry) return 0n
      return BigInt(d.amount ?? '0')
    }
    default:
      // Plan subscriptions renew with their plan and carry no mint in their
      // account: no finite allowance is provably enough for them.
      return null
  }
}

/**
 * The allowance that covers every live delegation on `mint` plus `extra`.
 * `null` when any of them is unbounded (then the approval stays as init set it).
 * Delegations without a mint (plan subscriptions) count against every mint.
 */
export function allowanceFor(
  delegations: DelegationView[],
  mint: string,
  nowS: bigint,
  extra: bigint | null = 0n,
  exclude?: string,
): bigint | null {
  if (extra === null) return null
  let total = extra
  for (const d of delegations) {
    if (d.address === exclude) continue
    if (d.mint !== null && d.mint !== mint) continue
    const left = delegationLifetime(d, nowS)
    if (left === null) return null
    total += left
  }
  return total
}
