/**
 * Every receipt is recorded, then pushed. The record is the source of truth
 * (digest, receipts list, widget); the push is its delivery. A push never
 * carries a number that is not also in the record, and every receipt that
 * moved or refused money carries its signature so it can be opened on an
 * explorer.
 */
import type { LedgerEvent } from './digest.js'
import type { MandateStore } from './mandate-store.js'
import { formatUnits, shortAddress } from './mandate-text.js'
import type { Logger } from './log.js'

export interface PushPort {
  /** Sends to every device registered for the address; resolves with per-token status. */
  toAddress(address: string, msg: { title: string; body: string; url: string }): Promise<number[]>
}

export interface ReceiptExtra {
  remainingBaseUnits?: bigint
  capBaseUnits?: bigint
  nextResetTs?: number
  cluster: 'devnet' | 'mainnet' | 'localnet'
}

/** Pure: the push a receipt becomes. Tested directly. */
export function receiptMessage(e: LedgerEvent, x: ReceiptExtra): { title: string; body: string; url: string } {
  const who = e.label ?? shortAddress(e.delegatee)
  const amt = e.amountBaseUnits ? `${formatUnits(BigInt(e.amountBaseUnits), e.decimals)} ${e.symbol}` : ''
  const left =
    x.remainingBaseUnits !== undefined && x.capBaseUnits !== undefined
      ? `${formatUnits(x.remainingBaseUnits, e.decimals)} of ${formatUnits(x.capBaseUnits, e.decimals)} ${e.symbol} left this period.`
      : ''
  const q = new URLSearchParams({
    source: 'receipt',
    kind: e.kind,
    who,
    pda: e.delegationPda,
    cluster: x.cluster,
    actor: e.actor,
  })
  // End-of-life receipts are keyed `revoked:<pda>` for dedupe; that is not a signature.
  if (e.signature && !e.signature.includes(':')) q.set('sig', e.signature)
  if (e.amountBaseUnits) q.set('amount', formatUnits(BigInt(e.amountBaseUnits), e.decimals))
  q.set('symbol', e.symbol)
  if (x.remainingBaseUnits !== undefined) q.set('remaining', formatUnits(x.remainingBaseUnits, e.decimals))
  if (x.capBaseUnits !== undefined) q.set('cap', formatUnits(x.capBaseUnits, e.decimals))
  if (x.nextResetTs) q.set('reset', String(x.nextResetTs))
  const url = `/alert?${q.toString()}`
  switch (e.kind) {
    case 'pull':
      return { title: `${who} received ${amt}`, body: `${left} Tap for the on-chain proof.`.trim(), url }
    case 'refused':
      return {
        title: `Refused by the chain: ${who}`,
        body: `A pull above your cap was rejected by the Solana program (0x190). Nothing moved.`,
        url,
      }
    case 'granted':
      return e.actor === 'other'
        ? {
            title: 'New permission on your wallet',
            body: `${who} can now pull ${e.symbol}. Not created in nuntius — check it.`,
            url,
          }
        : { title: `Mandate live: ${who}`, body: left || 'Authorized with one approval.', url }
    case 'revoked':
      return { title: `Revoked: ${who}`, body: 'It can no longer pull anything.', url }
    case 'expired':
      return { title: `Expired: ${who}`, body: 'The chain no longer allows pulls on it.', url }
  }
}

export class Receipts {
  constructor(
    private readonly store: MandateStore,
    private readonly push: PushPort | null,
    private readonly log: Logger,
    private readonly cluster: ReceiptExtra['cluster'],
  ) {}

  /** Records, and pushes only if this is the first time this receipt was recorded. */
  async emit(address: string, e: LedgerEvent, x: Omit<ReceiptExtra, 'cluster'> = {}): Promise<boolean> {
    const id = this.store.addEvent(address, e)
    if (id === null) return false
    this.log.info('receipt', {
      kind: e.kind,
      pda: e.delegationPda,
      sig: e.signature,
      actor: e.actor,
      amount: e.amountBaseUnits,
    })
    if (this.push) {
      try {
        const statuses = await this.push.toAddress(address, receiptMessage(e, { ...x, cluster: this.cluster }))
        this.log.info('push', { kind: e.kind, devices: statuses.length, statuses: statuses.join(',') })
      } catch (err) {
        // The receipt is recorded either way; a push failure must not undo it.
        this.log.warn('push_failed', { kind: e.kind, error: err instanceof Error ? err.message : 'unknown' })
      }
    }
    return true
  }
}
