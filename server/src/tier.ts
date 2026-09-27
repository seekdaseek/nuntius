/**
 * The tier gate. Two tiers, decided server-side from the verified session only:
 *
 * - basic  — any wallet signed in with SIWS.
 * - seeker — the session holds a verified Seeker Genesis Token (mint-keyed,
 *            see Store.claimSgtMint).
 *
 * The guard (seeing every delegation on the wallet, receipts for every pull,
 * one-signature revoke) is free for everyone: a safety feature that only paying
 * users get is not a safety feature. What the tier buys is scale and the daily
 * loop. SKR staking (BIBLE §7) is NOT implemented and is not claimed.
 */
export type Tier = 'basic' | 'seeker'

export interface TierLimits {
  maxActiveMandates: number
  dailyDigest: boolean
  streak: boolean
  guard: true
}

export const LIMITS: Record<Tier, TierLimits> = {
  basic: { maxActiveMandates: 1, dailyDigest: false, streak: false, guard: true },
  seeker: { maxActiveMandates: 10, dailyDigest: true, streak: true, guard: true },
}

export function tierOf(session: { sgtMint: string | null }): Tier {
  return session.sgtMint ? 'seeker' : 'basic'
}

export type GateResult =
  { ok: true } | { ok: false; error: 'tier_limit'; tier: Tier; limit: number; upgrade: string | null }

/** May this session open one more mandate? Pending (unsigned) ones count, so the cap cannot be raced. */
export function canCreateMandate(tier: Tier, openCount: number): GateResult {
  const limit = LIMITS[tier].maxActiveMandates
  if (openCount < limit) return { ok: true }
  return {
    ok: false,
    error: 'tier_limit',
    tier,
    limit,
    upgrade: tier === 'basic' ? 'Verify Seeker ownership to hold up to 10 mandates.' : null,
  }
}
