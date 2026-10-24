/**
 * Sends each Seeker-tier wallet its digest once per local day, at the hour it
 * chose, covering what happened since the previous one. The digest is built from recorded receipts plus live chain
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
  /**
   * When a wallet's failed digest may be tried again. Each try reads the wallet's permissions
   * on chain; without a wait, a failing digest read them every minute (23-24 Oct: 172 tries).
   */
  retryAt?: Map<string, number>
}

/** The wait after a failed digest before the next try. */
export const DIGEST_RETRY_MS = 10 * 60_000

export async function runDigests(d: DigestDeps, nowMs: number): Promise<string[]> {
  const sent: string[] = []
  for (const pref of d.mandates.allDigestPrefs()) {
    if (!digestDue(nowMs, pref)) continue
    if (nowMs < (d.retryAt?.get(pref.address) ?? 0)) continue
    // Tier is re-checked at send time: a wallet that lost Seeker verification stops getting it.
    if (!d.store.sgtForAddress(pref.address)) continue
    try {
      // Everything since the previous digest; the first one covers 24 hours.
      const since = pref.lastSentAtMs ?? null
      const digest = buildDigest(
        d.mandates.events(pref.address, since ?? nowMs - 24 * 3600_000),
        await d.live(pref.address),
        nowMs,
        since,
      )
      await d.push.toAddress(pref.address, {
        title: digest.title,
        body: digest.body,
        // Its own send time in the url: the app routes each tap once per process
        // by url, so two days' digests must not look like one tap.
        url: `/digest?source=digest&at=${nowMs}`,
        channel: 'digest',
      })
      d.mandates.markDigestSent(pref.address, localDay(nowMs, pref.tzOffsetMin), nowMs)
      d.retryAt?.delete(pref.address)
      d.log.info('digest_sent', { address: pref.address, pulls: digest.totals.pulls, refused: digest.totals.refused })
      sent.push(pref.address)
    } catch (e) {
      d.retryAt?.set(pref.address, nowMs + DIGEST_RETRY_MS)
      d.log.warn('digest_failed', { address: pref.address, error: safeError(e) })
    }
  }
  return sent
}
