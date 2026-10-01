/**
 * Which receipts show where. Home and the top of the receipts list show only
 * permissions that are live now, and only since their grant. Everything from
 * permissions that have ended goes under its own dated section, so a new
 * permission never inherits an old one's history (device check 2, 1 Oct:
 * natX's new grant sat under "Revoked: cj7check" and 8-day-old pulls).
 *
 * A nuntius permission is its mandate. Another app's delegation has no
 * mandate here: its instance is its address, ended by a "revoked" receipt.
 */
import type { LedgerEvent } from './digest.js'

export type FeedEvent = LedgerEvent & { id: number; mandateId: string | null }

export interface FeedMandate {
  id: string
  label: string
  symbol: string
  status: 'pending' | 'active' | 'revoked' | 'expired'
  createdAt: number
  endedAt: number | null
}

export interface EndedSection<E> {
  key: string
  label: string
  symbol: string
  /** First and last receipt of that permission, ms. */
  from: number
  to: number
  receipts: E[]
}

export function receiptFeed<E extends FeedEvent>(
  events: E[],
  mandates: FeedMandate[],
  /** Other apps' delegations live on the chain right now. */
  liveForeignPdas: Set<string>,
): { live: E[]; ended: EndedSection<E>[] } {
  const byId = new Map(mandates.map((m) => [m.id, m]))
  const live: E[] = []
  const ended = new Map<string, EndedSection<E>>()
  const end = (key: string, label: string, symbol: string, e: E) => {
    const s = ended.get(key) ?? { key, label, symbol, from: e.at, to: e.at, receipts: [] }
    s.receipts.push(e)
    s.from = Math.min(s.from, e.at)
    s.to = Math.max(s.to, e.at)
    ended.set(key, s)
  }
  // Another app's delegation: receipts after its last "revoked" belong to the
  // current instance; up to and including it, to an ended one.
  const lastRevoke = new Map<string, number>()
  for (const e of events) {
    if (e.mandateId === null && e.kind === 'revoked') {
      lastRevoke.set(e.delegationPda, Math.max(lastRevoke.get(e.delegationPda) ?? 0, e.at))
    }
  }
  for (const e of events) {
    if (e.mandateId !== null) {
      const m = byId.get(e.mandateId)
      if (m && m.status === 'active') live.push(e)
      else end(`m:${e.mandateId}`, m?.label || e.label || short(e.delegatee), m?.symbol ?? e.symbol, e)
      continue
    }
    const cut = lastRevoke.get(e.delegationPda)
    const current = cut === undefined || e.at > cut
    if (current && liveForeignPdas.has(e.delegationPda)) live.push(e)
    else end(`o:${e.delegationPda}:${current ? 'last' : cut}`, e.label || short(e.delegatee), e.symbol, e)
  }
  const newest = (a: E, b: E) => b.at - a.at || b.id - a.id
  live.sort(newest)
  const sections = [...ended.values()]
  for (const s of sections) s.receipts.sort(newest)
  sections.sort((a, b) => b.to - a.to)
  return { live, ended: sections }
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
