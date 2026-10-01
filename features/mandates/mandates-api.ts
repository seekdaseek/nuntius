import { AppConfig } from '@/constants/app-config'
import type { PeriodKey } from '@/core/mandate-form'

/** Typed client for the server's mandatum routes (server/src/mandates-api.ts). */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${AppConfig.apiBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await response.json()) as T & { ok: boolean; error?: string; message?: string }
  if (!response.ok || !json.ok) {
    throw new ApiError(
      json.error ?? `http_${response.status}`,
      json.message ?? json.error ?? `HTTP ${response.status}`,
      response.status,
    )
  }
  return json
}

export interface MandateText {
  headline: string
  schedule: string
  guarantee: string
  enforce: string
  exit: string
}

export interface MandateView {
  id: string
  label: string
  payee: string
  symbol: string
  decimals: number
  cap: string
  remaining: string | null
  nextResetTs: number | null
  periodLengthS: number
  expiryTs: number
  status: 'pending' | 'active' | 'revoked' | 'expired'
  delegationPda: string
  text: MandateText
}

export interface OtherDelegation {
  delegationPda: string
  kind: 'fixed' | 'recurring' | 'subscription'
  delegatee: string
  symbol: string
  decimals: number
  cap: string | null
  remaining: string | null
  nextResetTs: number | null
  periodLengthS: number | null
  expiryTs: number | null
  revocable: boolean
}

export interface ListResponse {
  tier: 'basic' | 'seeker'
  limits: { maxActiveMandates: number; dailyDigest: boolean; streak: boolean }
  mints: string[]
  cluster: 'mainnet' | 'localnet'
  demo: boolean
  mine: MandateView[]
  others: OtherDelegation[]
  tokenAccount: { delegate: string | null; delegatedAmount: string | null; balance: string | null }
  tokenAccounts?: {
    symbol: string
    exists: boolean
    delegate: string | null
    balance: string | null
    allowance?: string | null
  }[]
}

export interface Receipt {
  id: number
  /** The permission it belongs to (null for another app's delegation). */
  mandateId?: string | null
  kind: 'pull' | 'refused' | 'granted' | 'revoked' | 'expired'
  at: number
  delegationPda: string
  delegatee: string
  label: string | null
  amount: string | null
  symbol: string
  signature: string | null
  actor: 'nuntius' | 'other'
  /** The mandate's cap when nuntius knows it. */
  cap: string | null
  /** What was left right after this receipt, as recorded then (null for older receipts). */
  remaining?: string | null
  /** Unix seconds of the next reset at that time. */
  reset?: number | null
  /** The permission's period in seconds. */
  per?: number | null
}

export interface EndedReceipts {
  key: string
  label: string
  symbol: string
  from: number
  to: number
  receipts: Receipt[]
}

export interface Streak {
  current: number
  clockedInToday: boolean
  best: number
}

export interface DigestResponse {
  days: string[]
  today: string
  digest: { title: string; body: string; lines: string[]; expiringSoon: string[] }
  streak: Streak
  tier: 'basic' | 'seeker'
  prefs: { hour: number; tzOffsetMin: number; enabled: boolean } | null
}

export interface TermsInput {
  label: string
  payee: string
  amount: string
  period: PeriodKey
  untilDays: number
  symbol?: string
}

export const api = {
  list: (session: string) => post<ListResponse>('/api/mandates/list', { session }),
  preview: (session: string, t: TermsInput) =>
    post<{
      text: MandateText
      allowed: boolean
      upgrade: string | null
      tier: string
      symbol: string
      lifetimeTotal?: string | null
      allowanceTotal?: string | null
    }>('/api/mandates/preview', {
      session,
      ...t,
    }),
  create: (session: string, t: TermsInput) =>
    post<{
      mandateId: string
      transactionBase64: string
      delegationPda: string
      createsAuthority: boolean
      text: MandateText
    }>('/api/mandates/create', { session, ...t }),
  /** The same pending permission with a fresh blockhash. */
  rebuild: (session: string, mandateId: string) =>
    post<{ mandateId: string; transactionBase64: string; delegationPda: string }>('/api/mandates/rebuild', {
      session,
      mandateId,
    }),
  confirm: (session: string, mandateId: string) =>
    post<{ mandate: MandateView }>('/api/mandates/confirm', { session, mandateId }),
  revoke: (session: string, delegationPda: string) =>
    post<{ transactionBase64: string; revokesAuthority: boolean }>('/api/mandates/revoke', { session, delegationPda }),
  revokeConfirm: (session: string, delegationPda: string) =>
    post<{ revoked: boolean; tokenAccountDelegate: string | null }>('/api/mandates/revoke-confirm', {
      session,
      delegationPda,
    }),
  demoOverCap: (session: string, mandateId: string) =>
    post<{ signature: string; customCode: number | null; refusedByChain: boolean }>('/api/mandates/demo-overcap', {
      session,
      mandateId,
    }),
  /** Live permissions' receipts since their grant, plus each ended permission's, dated. */
  receipts: (session: string) =>
    post<{ receipts: Receipt[]; ended?: EndedReceipts[]; cluster: string }>('/api/receipts', { session }),
  digest: (session: string, tzOffsetMin: number) => post<DigestResponse>('/api/digest', { session, tzOffsetMin }),
  digestPrefs: (session: string, hour: number, tzOffsetMin: number, enabled: boolean) =>
    post<{ prefs: DigestResponse['prefs'] }>('/api/digest/prefs', { session, hour, tzOffsetMin, enabled }),
  clockIn: (session: string, tzOffsetMin: number) =>
    post<{ day: string; firstToday: boolean; streak: Streak; days: string[] }>('/api/clock-in', {
      session,
      tzOffsetMin,
    }),
  widget: (session: string, tzOffsetMin: number) =>
    post<Record<string, unknown>>('/api/widget', { session, tzOffsetMin }),
}

/** Retries `fn` while the chain has not caught up with a just-signed transaction. */
export async function untilLanded<T>(
  fn: () => Promise<T>,
  pendingCodes: string[],
  tries = 20,
  delayMs = 1_500,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof ApiError) || !pendingCodes.includes(e.code) || i >= tries - 1) throw e
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}
