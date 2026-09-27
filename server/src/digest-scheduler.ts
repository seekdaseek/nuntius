/**
 * Sends each Seeker-tier wallet its morning digest once per local day, at the
 * hour it chose. The digest is built from recorded receipts plus live chain
 * state, so what it says is what the receipts list and the chain say.
 */
import type { Store } from './db.js'
import type { MandateStore } from './mandate-store.js'
import type { PushPort } from './receipts.js'
import type { Logger } from './log.js'
import { safeError } from './log.js'
import { buildDigest, digestDue, localDay, type LiveMandate } from './digest.js'

export interface DigestDeps {
  store: Store
  mandates: MandateStore
  push: PushPort
  log: Logger
  live: (address: string) => Promise<LiveMandate[]>
}

export async function runDigests(d: DigestDeps, nowMs: number): Promise<string[]> {
  const sent: string[] = []
  for (const pref of d.mandates.allDigestPrefs()) {
    if (!digestDue(nowMs, pref)) continue
    // Tier is re-checked at send time: a wallet that lost Seeker verification stops getting it.
    if (!d.store.sgtForAddress(pref.address)) continue
    try {
      const digest = buildDigest(
        d.mandates.events(pref.address, nowMs - 24 * 3600_000),
        await d.live(pref.address),
        nowMs,
      )
      await d.push.toAddress(pref.address, { title: digest.title, body: digest.body, url: '/digest?source=digest' })
      d.mandates.markDigestSent(pref.address, localDay(nowMs, pref.tzOffsetMin))
      d.log.info('digest_sent', { address: pref.address, pulls: digest.totals.pulls, refused: digest.totals.refused })
      sent.push(pref.address)
    } catch (e) {
      d.log.warn('digest_failed', { address: pref.address, error: safeError(e) })
    }
  }
  return sent
}
