/**
 * Plain words for the token approval. Seed Vault shows the grant's SPL approval
 * as a warning ("allow a third party to spend your asset in the future"). The
 * approve screen explains it before Seed Vault opens, with the exact total the
 * transaction allows, from the server's preview.
 */
export interface AllowancePreview {
  symbol: string
  /** What this permission can take over its whole life. */
  lifetimeTotal: string | null
  /** The allowance the transaction sets: every live permission on this token plus this one.
   *  null = another permission has no end, so it stays unlimited; undefined = unknown. */
  allowanceTotal: string | null | undefined
}

export function approveNote(p: AllowancePreview): string {
  const sym = p.symbol
  const own = p.lifetimeTotal ? `This permission can take at most ${p.lifetimeTotal} ${sym} in total.` : ''
  const warning = `Seed Vault may also warn that a third party can spend your ${sym} in the future: that is the Subscriptions program, held to the terms above.`
  if (p.allowanceTotal === null) {
    return `${own} Seed Vault will show no limit, because another app's permission on ${sym} has no end date and one approval covers them all. ${warning}`.trim()
  }
  if (p.allowanceTotal === undefined) return `${own} ${warning}`.trim()
  // One token account has one delegate, so the approval is the sum of every live
  // permission on it. Say which part is this permission's (device check 2, 1 Oct:
  // "caps it at 1.98 USDC" when this one could take 1.68 and another 0.30).
  if (p.allowanceTotal === p.lifetimeTotal) {
    return `${own} Seed Vault will show ${p.allowanceTotal} ${sym}. ${warning}`.trim()
  }
  return `${own} Seed Vault will show ${p.allowanceTotal} ${sym}, because one approval covers all your live ${sym} permissions. ${warning}`.trim()
}

export interface TokenAccountView {
  symbol: string
  delegate: string | null
  /** The token-level cap left on the delegate; null = unlimited or none. */
  allowance?: string | null
}

/** The home screen's line about who may move tokens from the wallet's accounts. */
export function delegateLine(accounts: TokenAccountView[], short: (a: string) => string): string {
  const withDelegate = accounts.filter((a) => a.delegate)
  if (withDelegate.length === 0) return 'Token account delegate: none'
  return withDelegate
    .map(
      (a) =>
        `${a.symbol} token account delegate: ${short(a.delegate!)}, the Subscriptions program's authority, ${
          a.allowance ? `allowed ${a.allowance} ${a.symbol} in total` : 'with no cap'
        }`,
    )
    .join('\n')
}

/**
 * The one line directly above Approve: what Seed Vault is about to show.
 * "Why?" opens approveNote (device check 2, 1 Oct: the five-line explainer sat
 * below the fold).
 */
export function approveLine(p: AllowancePreview): string {
  if (p.allowanceTotal === null) return 'Seed Vault will show no limit.'
  if (p.allowanceTotal === undefined) return 'One approval in Seed Vault.'
  if (p.allowanceTotal === p.lifetimeTotal) return `Seed Vault will show ${p.allowanceTotal} ${p.symbol}.`
  return `Seed Vault will show ${p.allowanceTotal} ${p.symbol} in total.`
}
