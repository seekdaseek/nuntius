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
  const lead = `Seed Vault may warn that this lets a third party spend your ${p.symbol} in the future. That third party is the Subscriptions program`
  if (p.allowanceTotal === null) {
    return `${lead}, and it cannot be capped: another app's permission on ${p.symbol} has no end date. The program still holds this permission to the terms above.`
  }
  if (p.allowanceTotal === undefined) {
    return p.lifetimeTotal
      ? `${lead}. This approval caps what it can move from your ${p.symbol} at the total of your live permissions; this one can take at most ${p.lifetimeTotal} ${p.symbol} in all.`
      : `${lead}. The program holds this permission to the terms above.`
  }
  if (p.allowanceTotal === p.lifetimeTotal) {
    return `${lead}, and this approval caps it at ${p.allowanceTotal} ${p.symbol} in total: the most this permission can take in its whole life.`
  }
  return `${lead}, and this approval caps it at ${p.allowanceTotal} ${p.symbol} in total: what all your live ${p.symbol} permissions can still take, this one included.`
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
