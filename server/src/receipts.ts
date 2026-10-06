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
  toAddress(address: string, msg: PushMessage): Promise<number[]>
}

export interface PushMessage {
  title: string
  body: string
  url: string
  channel?: 'alerts' | 'digest'
  /** Android tray tag: a newer push with the same tag replaces the older one. */
  tag?: string
}

/**
 * The FCM parts of a push. One tag per permission (and one for the digest)
 * keeps the tray to one notification per permission: when an app has several
 * notifications showing, Android folds them into a collapsed group, and a tap
 * on that group opens the app without any notification's data, so it cannot
 * land on the receipt (device check 5, 30 Sep).
 */
export function fcmParts(msg: PushMessage): {
  notification: { title: string; body: string }
  channelId: 'alerts' | 'digest'
  data: Record<string, string>
  tag: string | undefined
} {
  const channelId = msg.channel ?? 'alerts'
  const tag = msg.tag ?? (channelId === 'digest' ? 'digest' : undefined)
  return {
    notification: { title: msg.title, body: msg.body },
    channelId,
    // The tag rides in data too. With the app in the background Android draws
    // the push and uses android.notification.tag; with the app open,
    // expo-notifications draws it and takes its id from data.tag. Without it,
    // "Permission live" and "received" sat side by side, Android grouped them,
    // and a tap on the group opened nothing (device check 5, 1 Oct, 05a).
    data: { url: msg.url, channelId, ...(tag ? { tag } : {}) },
    tag,
  }
}

export interface ReceiptExtra {
  remainingBaseUnits?: bigint
  capBaseUnits?: bigint
  nextResetTs?: number
  /** The permission's period, so the receipt can say "today" or "this hour". */
  periodLengthS?: number
  cluster: 'devnet' | 'mainnet' | 'localnet'
  /** Skipped buys: the slippage bound that was not met, in percent. */
  slippagePct?: number
}

/** Pure: the push a receipt becomes. Tested directly. */
export function receiptMessage(e: LedgerEvent, x: ReceiptExtra): PushMessage & { tag: string } {
  return { ...receiptBody(e, x), tag: `permission:${e.delegationPda}` }
}

function receiptBody(e: LedgerEvent, x: ReceiptExtra): { title: string; body: string; url: string } {
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
    at: String(e.at),
  })
  // End-of-life receipts are keyed `revoked:<pda>` for dedupe; that is not a signature.
  if (e.signature && !e.signature.includes(':')) q.set('sig', e.signature)
  // A migration receipt is keyed per permission; the migration's own signature is its note.
  if (e.kind === 'migrated' && e.note) q.set('sig', e.note)
  if (e.kind === 'migrated' && e.outSymbol) q.set('got', e.outSymbol)
  if (e.amountBaseUnits) q.set('amount', formatUnits(BigInt(e.amountBaseUnits), e.decimals))
  q.set('symbol', e.symbol)
  if (x.remainingBaseUnits !== undefined) q.set('remaining', formatUnits(x.remainingBaseUnits, e.decimals))
  if (x.capBaseUnits !== undefined) q.set('cap', formatUnits(x.capBaseUnits, e.decimals))
  if (x.nextResetTs) q.set('reset', String(x.nextResetTs))
  if (x.periodLengthS) q.set('per', String(x.periodLengthS))
  const got =
    e.outBaseUnits && e.outSymbol ? `${formatUnits(BigInt(e.outBaseUnits), e.outDecimals ?? 0)} ${e.outSymbol}` : ''
  if (got) q.set('got', got)
  if (e.kind === 'skipped' && e.note) q.set('why', e.note)
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
        : { title: `Permission live: ${who}`, body: left || 'Authorized with one approval.', url }
    case 'revoked':
      return { title: `Revoked: ${who}`, body: 'It can no longer pull anything.', url }
    case 'expired':
      return { title: `Expired: ${who}`, body: 'The chain no longer allows pulls on it.', url }
    case 'buy':
      return {
        title: got ? `Bought ${got} for ${amt}` : `Bought ${who} for ${amt}`,
        body: `Delivered to your own account. ${left} Tap for the on-chain proof.`.trim(),
        url,
      }
    case 'skipped':
      return { title: `Skipped: ${who}`, body: skipWords(e.note ?? 'slippage', x.slippagePct ?? 2), url }
    case 'migrated':
      return {
        title: `${e.outSymbol ?? 'The token'} moved to its regular pool`,
        body: `${who}: the curve filled and migrated to Meteora DAMM v2. Your next buys go there. You signed nothing.`,
        url,
      }
  }
}

export class Receipts {
  constructor(
    private readonly store: MandateStore,
    private readonly push: PushPort | null,
    private readonly log: Logger,
    private readonly cluster: ReceiptExtra['cluster'],
    /** Told about every receipt recorded for the first time (the public feed's stream). */
    private readonly onRecorded?: (address: string, e: LedgerEvent) => void,
  ) {}

  /** Records, and pushes only if this is the first time this receipt was recorded. */
  async emit(address: string, e: LedgerEvent, x: Omit<ReceiptExtra, 'cluster'> = {}): Promise<boolean> {
    const id = this.store.addEvent(address, e, {
      remainingBaseUnits: x.remainingBaseUnits?.toString(),
      capBaseUnits: x.capBaseUnits?.toString(),
      nextResetTs: x.nextResetTs,
      periodLengthS: x.periodLengthS,
    })
    if (id === null) return false
    try {
      this.onRecorded?.(address, e)
    } catch {
      /* the feed is a side channel: never let it stop a receipt */
    }
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

/** Why a buy was skipped, in one sentence (meteora.ts swapFailure). Nothing was ever taken. */
export function skipWords(note: string, slippagePct = 2): string {
  if (note === 'curve_full')
    return 'The curve filled before this buy. Nothing was taken; it buys in the regular pool once the token moves there.'
  if (note === 'no_room') return 'The curve had less room left than quoted. Nothing was taken.'
  if (note.startsWith('error:')) return `The swap failed with error ${note.slice(6)}. Nothing was taken.`
  return `The price moved more than ${slippagePct}%. Nothing was taken.`
}
