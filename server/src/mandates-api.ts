/**
 * The mandatum HTTP surface the app talks to. Every route is session-gated and
 * takes the wallet from the verified session, never from the body. Every
 * transaction it returns is unsigned, owner-paid and owner-signed only — the
 * server never holds a user key.
 *
 *   POST /api/mandates/preview        sentence + validation, no chain writes
 *   POST /api/mandates/create         ONE transaction to sign: init + create
 *   POST /api/mandates/confirm        activates only if the chain matches the terms exactly
 *   POST /api/mandates/list           nuntius mandates + every other delegation on the wallet
 *   POST /api/mandates/revoke         ONE transaction to sign, for any fixed/recurring delegation
 *   POST /api/mandates/revoke-confirm
 *   POST /api/mandates/demo-overcap   (DEMO_ENDPOINTS=1 only) real 0x190 on chain
 *   POST /api/receipts                recent receipts
 *   POST /api/digest                  today's digest + streak
 *   POST /api/digest/prefs            hour + timezone offset + on/off
 *   POST /api/clock-in                records today, returns the streak
 *   POST /api/widget                  compact snapshot for the home-screen widget
 */
import type express from 'express'
import type { Address } from '@solana/kit'
import type { Store } from './db.js'
import type { MandateStore, Mandate } from './mandate-store.js'
import type { MandateConfig, MintInfo } from './mandate-config.js'
import type { Receipts } from './receipts.js'
import type { Executor } from './executor.js'
import {
  buildGrantTx,
  buildRevokeTx,
  effectiveWindow,
  listDelegations,
  readAta,
  readRecurring,
  userAtaOf,
  type DelegationView,
} from './mandate-chain.js'
import { cleanLabel, describeMandate, formatUnits, parseUnits, PERIODS, type PeriodKey } from './mandate-text.js'
import { canCreateMandate, LIMITS, tierOf } from './tier.js'
import { buildDigest, computeStreak, localDay, type LiveMandate } from './digest.js'
import { safeError } from './log.js'
import { clientIp, tooMany, type Limits } from './rate-limit.js'
import type { Rpc } from './tx.js'

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const PENDING_TTL_MS = 10 * 60_000

export interface MandateApiDeps {
  store: Store
  mandates: MandateStore
  cfg: MandateConfig
  rpc: Rpc
  delegatee: Address
  receipts: Receipts
  executor: Executor | null
  limits?: Pick<Limits, 'demoPerIp' | 'demoPerMandate'>
  now?: () => number
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code)
  }
}

type Body = Record<string, unknown>

export function registerMandateRoutes(app: express.Express, deps: MandateApiDeps): void {
  const now = deps.now ?? Date.now
  const { mandates, cfg, rpc } = deps

  const auth = (body: Body) => {
    const session = typeof body.session === 'string' && SESSION_TOKEN_RE.test(body.session) ? body.session : null
    if (!session) throw new HttpError(400, 'bad_request')
    const s = deps.store.getSession(session)
    if (!s) throw new HttpError(401, 'session_invalid')
    const tier = tierOf(s)
    return { address: s.address, sgtMint: s.sgtMint, tier, limits: LIMITS[tier] }
  }

  const route = (path: string, handler: (body: Body) => Promise<Record<string, unknown>>) => {
    app.post(path, (req, res) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Body
      handler(body)
        .then((out) => res.json({ ok: true, ...out }))
        .catch((e: unknown) => {
          if (e instanceof HttpError) {
            res.status(e.status).json({ ok: false, error: e.code, message: e.message, ...e.extra })
          } else {
            res.status(502).json({ ok: false, error: 'chain_error', message: safeError(e) })
          }
        })
    })
  }

  const mintBySymbol = (symbol: unknown): MintInfo => {
    const m = cfg.mints.find((x) => x.symbol === symbol) ?? (symbol === undefined ? cfg.mints[0] : undefined)
    if (!m) throw new HttpError(400, 'bad_mint', `supported: ${cfg.mints.map((x) => x.symbol).join(', ')}`)
    return m
  }
  const mintInfo = (mint: string): { symbol: string; decimals: number } =>
    cfg.mints.find((x) => x.mint === mint) ?? { symbol: `${mint.slice(0, 4)}…`, decimals: 0 }

  /** Parses and validates what the user typed. Shared by preview and create so they cannot disagree. */
  const parseTerms = (body: Body, owner: string) => {
    let label: string
    try {
      label = cleanLabel(body.label)
    } catch (e) {
      throw new HttpError(400, 'bad_label', safeError(e))
    }
    const payee = typeof body.payee === 'string' ? body.payee.trim() : ''
    if (!ADDRESS_RE.test(payee)) throw new HttpError(400, 'bad_payee', 'payee must be a Solana address')
    if (payee === owner) throw new HttpError(400, 'bad_payee', 'payee cannot be the paying wallet itself')
    const mint = mintBySymbol(body.symbol)
    let amount: bigint
    try {
      amount = parseUnits(typeof body.amount === 'string' ? body.amount : String(body.amount ?? ''), mint.decimals)
    } catch (e) {
      throw new HttpError(400, 'bad_amount', safeError(e))
    }
    const ceilingUi = mint.maxPerPeriodUi ?? cfg.maxPerPeriodUi
    const ceiling = parseUnits(ceilingUi, mint.decimals)
    if (amount > ceiling) {
      throw new HttpError(400, 'over_beta_ceiling', `beta limit: at most ${ceilingUi} ${mint.symbol} per period`)
    }
    const periodKey = (typeof body.period === 'string' ? body.period : '') as PeriodKey
    const periodLengthS = PERIODS[periodKey]
    if (!periodLengthS) throw new HttpError(400, 'bad_period', `period: ${Object.keys(PERIODS).join(', ')}`)
    const untilDays = Number(body.untilDays ?? 90)
    // Every mandate ends. Start-on-landing requires an expiry, and an open-ended
    // permission is exactly what this app exists to prevent.
    if (!Number.isInteger(untilDays) || untilDays < 1 || untilDays > 365) {
      throw new HttpError(400, 'bad_until', 'untilDays must be 1–365')
    }
    const expiryTs = Math.floor(now() / 1000) + untilDays * 86_400
    const text = describeMandate({
      label,
      payee,
      amountBaseUnits: amount,
      decimals: mint.decimals,
      symbol: mint.symbol,
      periodLengthS,
      expiryTs,
    })
    return { label, payee, mint, amount, periodLengthS, expiryTs, text }
  }

  const gate = (a: ReturnType<typeof auth>) => {
    const g = canCreateMandate(a.tier, mandates.openCount(a.address, PENDING_TTL_MS, now()))
    if (!g.ok)
      throw new HttpError(403, 'tier_limit', g.upgrade ?? 'mandate limit reached', { tier: g.tier, limit: g.limit })
  }

  route('/api/mandates/preview', async (body) => {
    const a = auth(body)
    const t = parseTerms(body, a.address)
    const g = canCreateMandate(a.tier, mandates.openCount(a.address, PENDING_TTL_MS, now()))
    return {
      text: t.text,
      amountBaseUnits: t.amount.toString(),
      symbol: t.mint.symbol,
      periodLengthS: t.periodLengthS,
      expiryTs: t.expiryTs,
      tier: a.tier,
      allowed: g.ok,
      upgrade: g.ok ? null : g.upgrade,
    }
  })

  route('/api/mandates/create', async (body) => {
    const a = auth(body)
    gate(a)
    const t = parseTerms(body, a.address)
    const [receiverAta, userAta] = await Promise.all([
      userAtaOf(t.payee as Address, t.mint.mint as Address),
      userAtaOf(a.address as Address, t.mint.mint as Address),
    ])
    const r = await readAta(rpc, receiverAta)
    if (!r.exists || r.owner !== t.payee || r.mint !== t.mint.mint) {
      throw new HttpError(400, 'payee_has_no_account', `the payee has no ${t.mint.symbol} account yet`)
    }
    const nonce = mandates.nextNonce(a.address, deps.delegatee)
    const grant = await buildGrantTx(rpc, {
      owner: a.address as Address,
      mint: t.mint.mint as Address,
      delegatee: deps.delegatee,
      nonce: BigInt(nonce),
      amountPerPeriod: t.amount,
      periodLengthS: BigInt(t.periodLengthS),
      startTs: 0n,
      expiryTs: BigInt(t.expiryTs),
    })
    mandates.deleteStalePending(PENDING_TTL_MS, now())
    const m = mandates.insertMandate(
      {
        address: a.address,
        label: t.label,
        payee: t.payee,
        receiverAta,
        mint: t.mint.mint,
        symbol: t.mint.symbol,
        decimals: t.mint.decimals,
        amountPerPeriod: t.amount.toString(),
        pullAmount: t.amount.toString(),
        periodLengthS: t.periodLengthS,
        expiryTs: t.expiryTs,
        nonce,
        delegatee: deps.delegatee,
        delegationPda: grant.delegationPda,
        authorityPda: grant.authorityPda,
        userAta,
      },
      now(),
    )
    return {
      mandateId: m.id,
      transactionBase64: grant.transactionBase64,
      delegationPda: grant.delegationPda,
      createsAuthority: grant.createsAuthority,
      text: t.text,
    }
  })

  route('/api/mandates/confirm', async (body) => {
    const a = auth(body)
    const m = typeof body.mandateId === 'string' ? mandates.getMandate(body.mandateId) : null
    if (!m || m.address !== a.address) throw new HttpError(404, 'no_mandate')
    if (m.status === 'active') return { mandate: await view(m) }
    if (m.status !== 'pending') throw new HttpError(409, 'not_pending')
    const d = await readRecurring(rpc, m.delegationPda as Address)
    if (!d.exists) throw new HttpError(409, 'not_on_chain_yet', 'the grant has not landed yet')
    // Activate only on an exact match: the chain, not the request, is the record.
    const match =
      d.delegator === m.address &&
      d.delegatee === m.delegatee &&
      d.mint === m.mint &&
      d.amountPerPeriod === BigInt(m.amountPerPeriod) &&
      d.periodLengthS === BigInt(m.periodLengthS) &&
      d.expiryTs === BigInt(m.expiryTs)
    if (!match) throw new HttpError(409, 'terms_mismatch', 'the on-chain delegation does not match this permission')
    mandates.setStatus(m.id, 'active', now())
    mandates.setGuardCursor(m.delegationPda, a.address, null, now(), { delegatee: m.delegatee, mint: m.mint })
    await deps.receipts.emit(
      a.address,
      {
        kind: 'granted',
        at: now(),
        delegationPda: m.delegationPda,
        delegatee: m.delegatee,
        label: m.label || null,
        amountBaseUnits: m.amountPerPeriod,
        decimals: m.decimals,
        symbol: m.symbol,
        signature: `granted:${m.delegationPda}`,
        actor: 'nuntius',
      },
      { capBaseUnits: BigInt(m.amountPerPeriod), remainingBaseUnits: BigInt(m.amountPerPeriod) },
    )
    return { mandate: await view(mandates.getMandate(m.id)!) }
  })

  const windowOf = (d: {
    amountPerPeriod: bigint
    amountPulledInPeriod: bigint
    currentPeriodStartTs: bigint
    periodLengthS: bigint
    expiryTs: bigint
  }) => {
    const w = effectiveWindow(d, BigInt(Math.floor(now() / 1000)))
    return {
      remaining: w.remaining.toString(),
      used: w.used.toString(),
      nextResetTs: Number(w.nextResetTs),
      expired: w.expired,
    }
  }

  const view = async (m: Mandate, live?: DelegationView) => {
    const text = describeMandate({
      label: m.label,
      payee: m.payee,
      amountBaseUnits: BigInt(m.amountPerPeriod),
      decimals: m.decimals,
      symbol: m.symbol,
      periodLengthS: m.periodLengthS,
      expiryTs: m.expiryTs,
    })
    const d = live
      ? live.amountPerPeriod !== null
        ? {
            amountPerPeriod: BigInt(live.amountPerPeriod),
            amountPulledInPeriod: BigInt(live.amountPulledInPeriod ?? '0'),
            currentPeriodStartTs: BigInt(live.currentPeriodStartTs ?? 0),
            periodLengthS: BigInt(live.periodLengthS ?? 1),
            expiryTs: BigInt(live.expiryTs ?? 0),
          }
        : null
      : m.status === 'active'
        ? await readRecurring(rpc, m.delegationPda as Address).then((r) =>
            r.exists
              ? {
                  amountPerPeriod: r.amountPerPeriod!,
                  amountPulledInPeriod: r.amountPulledInPeriod!,
                  currentPeriodStartTs: r.currentPeriodStartTs!,
                  periodLengthS: r.periodLengthS!,
                  expiryTs: r.expiryTs!,
                }
              : null,
          )
        : null
    const w = d ? windowOf(d) : null
    return {
      id: m.id,
      label: m.label,
      payee: m.payee,
      symbol: m.symbol,
      decimals: m.decimals,
      cap: formatUnits(BigInt(m.amountPerPeriod), m.decimals),
      capBaseUnits: m.amountPerPeriod,
      remaining: w ? formatUnits(BigInt(w.remaining), m.decimals) : null,
      remainingBaseUnits: w?.remaining ?? null,
      nextResetTs: w?.nextResetTs ?? null,
      periodLengthS: m.periodLengthS,
      expiryTs: m.expiryTs,
      status: m.status,
      delegationPda: m.delegationPda,
      text,
    }
  }

  route('/api/mandates/list', async (body) => {
    const a = auth(body)
    const onChain = await listDelegations(rpc, a.address as Address)
    const byPda = new Map(onChain.map((d) => [d.address as string, d]))
    const own = mandates.listMandates(a.address).filter((m) => m.status === 'active' || m.status === 'pending')
    const ownPdas = new Set(own.map((m) => m.delegationPda))
    const mine = await Promise.all(
      own.filter((m) => m.status === 'active').map((m) => view(m, byPda.get(m.delegationPda))),
    )
    const others = onChain
      .filter((d) => !ownPdas.has(d.address))
      .map((d) => {
        const info = d.mint ? mintInfo(d.mint) : { symbol: '?', decimals: 0 }
        const w =
          d.kind === 'recurring' && d.amountPerPeriod
            ? windowOf({
                amountPerPeriod: BigInt(d.amountPerPeriod),
                amountPulledInPeriod: BigInt(d.amountPulledInPeriod ?? '0'),
                currentPeriodStartTs: BigInt(d.currentPeriodStartTs ?? 0),
                periodLengthS: BigInt(d.periodLengthS ?? 1),
                expiryTs: BigInt(d.expiryTs ?? 0),
              })
            : null
        return {
          delegationPda: d.address,
          kind: d.kind,
          delegatee: d.delegatee,
          symbol: info.symbol,
          decimals: info.decimals,
          cap: d.amountPerPeriod ? formatUnits(BigInt(d.amountPerPeriod), info.decimals) : null,
          remaining: w
            ? formatUnits(BigInt(w.remaining), info.decimals)
            : d.amount
              ? formatUnits(BigInt(d.amount), info.decimals)
              : null,
          nextResetTs: w?.nextResetTs ?? null,
          periodLengthS: d.periodLengthS,
          expiryTs: d.expiryTs,
          revocable: d.kind !== 'subscription',
        }
      })
    // One token account per offered mint; each can carry the program's authority as its delegate.
    const tokenAccounts = await Promise.all(
      cfg.mints.map(async (m) => {
        const ata = await readAta(rpc, await userAtaOf(a.address as Address, m.mint as Address))
        return { symbol: m.symbol, exists: ata.exists, delegate: ata.delegate, balance: ata.amount }
      }),
    )
    const ata = tokenAccounts[0]!
    return {
      tier: a.tier,
      limits: a.limits,
      mints: cfg.mints.map((m) => m.symbol),
      cluster: cfg.cluster,
      demo: cfg.demoEndpoints,
      mine,
      others,
      tokenAccount: { delegate: ata.delegate, balance: ata.balance },
      tokenAccounts,
    }
  })

  /** Resolves a delegation the caller owns, from the chain. Never trusts the body's claim of ownership. */
  const ownedDelegation = async (address: string, pda: unknown): Promise<DelegationView> => {
    if (typeof pda !== 'string' || !ADDRESS_RE.test(pda)) throw new HttpError(400, 'bad_request')
    const d = (await listDelegations(rpc, address as Address)).find((x) => x.address === pda)
    if (!d) throw new HttpError(404, 'no_delegation')
    if (d.kind === 'subscription')
      throw new HttpError(409, 'use_merchant_cancel', 'subscriptions are cancelled, not revoked')
    return d
  }

  route('/api/mandates/revoke', async (body) => {
    const a = auth(body)
    const d = await ownedDelegation(a.address, body.delegationPda)
    // Remember who it was while the account still exists; the receipt needs it after.
    mandates.setGuardCursor(d.address, a.address, null, now(), { delegatee: d.delegatee, mint: d.mint })
    const r = await buildRevokeTx(rpc, a.address as Address, d.address, d.mint as Address)
    return { transactionBase64: r.transactionBase64, revokesAuthority: r.revokesAuthority, delegationPda: d.address }
  })

  route('/api/mandates/revoke-confirm', async (body) => {
    const a = auth(body)
    const pda =
      typeof body.delegationPda === 'string' && ADDRESS_RE.test(body.delegationPda) ? body.delegationPda : null
    if (!pda) throw new HttpError(400, 'bad_request')
    const still = (await listDelegations(rpc, a.address as Address)).some((x) => x.address === pda)
    if (still) throw new HttpError(409, 'still_live', 'the revoke has not landed yet')
    const m = mandates.getMandateByPda(pda)
    if (m && m.address === a.address && m.status === 'active') mandates.setStatus(m.id, 'revoked', now())
    const memory = mandates.guardMemory(pda)
    const info = m
      ? { symbol: m.symbol, decimals: m.decimals }
      : memory.mint
        ? mintInfo(memory.mint)
        : { symbol: '?', decimals: 0 }
    await deps.receipts.emit(a.address, {
      kind: 'revoked',
      at: now(),
      delegationPda: pda,
      delegatee: m?.delegatee ?? memory.delegatee ?? 'unknown',
      label: m?.label || null,
      amountBaseUnits: null,
      ...info,
      signature: `revoked:${pda}`,
      actor: m ? 'nuntius' : 'other',
    })
    mandates.dropGuardCursor(pda)
    const ata = await readAta(
      rpc,
      await userAtaOf(a.address as Address, (m?.mint ?? memory.mint ?? cfg.mints[0]!.mint) as Address),
    )
    return { revoked: true, tokenAccountDelegate: ata.delegate }
  })

  if (cfg.demoEndpoints) {
    // Every call spends the delegatee's SOL on a transaction that is meant to fail,
    // so it is limited per client IP and, tightly, per mandate.
    app.post('/api/mandates/demo-overcap', (req, res, next) => {
      const lim = deps.limits
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Body
      if (lim) {
        const waitIp = lim.demoPerIp.take(clientIp(req))
        const waitM = waitIp > 0 ? 0 : lim.demoPerMandate.take(String(body.mandateId ?? ''))
        const wait = Math.max(waitIp, waitM)
        if (wait > 0) return tooMany(res, wait)
      }
      next()
    })
    route('/api/mandates/demo-overcap', async (body) => {
      const a = auth(body)
      const m = typeof body.mandateId === 'string' ? mandates.getMandate(body.mandateId) : null
      // The app shows these messages as they are, under "Try to take more".
      if (!m || m.address !== a.address || m.status !== 'active')
        throw new HttpError(404, 'no_mandate', 'This permission is no longer live.')
      if (!deps.executor) throw new HttpError(503, 'not_configured', 'The demo is off on this server.')
      const r = await deps.executor.demoOverCap(m)
      return { signature: r.signature, customCode: r.customCode, refusedByChain: r.customCode === 400 }
    })
  }

  route('/api/receipts', async (body) => {
    const a = auth(body)
    const limit = Math.min(Math.max(Number(body.limit ?? 50) || 50, 1), 200)
    return {
      receipts: mandates.events(a.address, 0, limit).map((e) => ({
        ...e,
        // The mandate's cap, when nuntius knows it: the refused receipt shows "cap this period".
        cap: ((m) => (m ? formatUnits(BigInt(m.amountPerPeriod), m.decimals) : null))(
          mandates.getMandateByPda(e.delegationPda),
        ),
        amount: e.amountBaseUnits ? formatUnits(BigInt(e.amountBaseUnits), e.decimals) : null,
        signature: e.signature && !e.signature.includes(':') ? e.signature : null,
      })),
      cluster: cfg.cluster,
    }
  })

  const liveMandates = (address: string) => liveMandatesFor(rpc, mandates, cfg, address, now())

  const tzOf = (body: Body) => {
    const tz = Number(body.tzOffsetMin ?? 0)
    if (!Number.isInteger(tz) || tz < -720 || tz > 840) throw new HttpError(400, 'bad_tz')
    return tz
  }

  route('/api/digest', async (body) => {
    const a = auth(body)
    const tz = tzOf(body)
    const digest = buildDigest(mandates.events(a.address, now() - 24 * 3600_000), await liveMandates(a.address), now())
    const streak = computeStreak(mandates.clockInDays(a.address), localDay(now(), tz))
    const days = mandates.clockInDays(a.address).slice(-14)
    return { digest, streak, days, today: localDay(now(), tz), tier: a.tier, prefs: mandates.digestPrefs(a.address) }
  })

  route('/api/digest/prefs', async (body) => {
    const a = auth(body)
    if (!a.limits.dailyDigest)
      throw new HttpError(403, 'tier_limit', 'Verify Seeker ownership to get the daily digest.')
    const hour = Number(body.hour)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new HttpError(400, 'bad_hour')
    mandates.setDigestPrefs(a.address, hour, tzOf(body), body.enabled !== false)
    return { prefs: mandates.digestPrefs(a.address) }
  })

  route('/api/clock-in', async (body) => {
    const a = auth(body)
    if (!a.limits.streak) throw new HttpError(403, 'tier_limit', 'Verify Seeker ownership to keep a streak.')
    const day = localDay(now(), tzOf(body))
    const first = mandates.clockIn(a.address, day, now())
    const days = mandates.clockInDays(a.address)
    return { day, firstToday: first, streak: computeStreak(days, day), days: days.slice(-14) }
  })

  route('/api/widget', async (body) => {
    const a = auth(body)
    const live = await liveMandates(a.address)
    const last = mandates.events(a.address, 0, 1)[0] ?? null
    const streak = computeStreak(mandates.clockInDays(a.address), localDay(now(), tzOf(body)))
    return {
      rows: live.slice(0, 3).map((m) => ({
        label: m.label ?? `${m.delegatee.slice(0, 4)}…${m.delegatee.slice(-4)}`,
        remaining: formatUnits(BigInt(m.remainingBaseUnits), m.decimals),
        cap: formatUnits(BigInt(m.capBaseUnits), m.decimals),
        symbol: m.symbol,
        nextResetTs: m.nextResetTs,
      })),
      liveCount: live.length,
      lastReceipt: last
        ? {
            kind: last.kind,
            at: last.at,
            label: last.label,
            amount: last.amountBaseUnits ? formatUnits(BigInt(last.amountBaseUnits), last.decimals) : null,
            symbol: last.symbol,
          }
        : null,
      streak: a.limits.streak ? streak.current : null,
      clockedInToday: a.limits.streak ? streak.clockedInToday : null,
    }
  })
}

/** Every live recurring delegation on the wallet, with what the program would allow right now. */
export async function liveMandatesFor(
  rpc: Rpc,
  mandates: MandateStore,
  cfg: MandateConfig,
  address: string,
  nowMs: number,
): Promise<LiveMandate[]> {
  const onChain = await listDelegations(rpc, address as Address)
  return onChain
    .filter((d) => d.kind === 'recurring' && d.amountPerPeriod && d.mint)
    .map((d) => {
      const m = mandates.getMandateByPda(d.address)
      const info = cfg.mints.find((x) => x.mint === d.mint) ?? { symbol: `${d.mint!.slice(0, 4)}…`, decimals: 0 }
      const w = effectiveWindow(
        {
          amountPerPeriod: BigInt(d.amountPerPeriod!),
          amountPulledInPeriod: BigInt(d.amountPulledInPeriod ?? '0'),
          currentPeriodStartTs: BigInt(d.currentPeriodStartTs ?? 0),
          periodLengthS: BigInt(d.periodLengthS ?? 1),
          expiryTs: BigInt(d.expiryTs ?? 0),
        },
        BigInt(Math.floor(nowMs / 1000)),
      )
      return {
        delegationPda: d.address,
        label: m?.label || null,
        delegatee: d.delegatee,
        remainingBaseUnits: w.remaining.toString(),
        capBaseUnits: d.amountPerPeriod!,
        decimals: info.decimals,
        symbol: info.symbol,
        nextResetTs: Number(w.nextResetTs),
        expiryTs: d.expiryTs ?? 0,
      }
    })
}
