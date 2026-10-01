/**
 * mandatum on chain: the one-signature grant, the one-signature revoke, and the
 * reads everything else is built from.
 *
 * ONE signature to grant. `initSubscriptionAuthority` and
 * `createRecurringDelegation` go in a single transaction. When the authority
 * does not exist yet, the delegation pins `UNKNOWN_INIT_ID` (i64::MIN), which
 * the program accepts only when the authority's `init_id` equals the current
 * slot — i.e. it was created in this same transaction (program 0.5.0, #206).
 * When the authority already exists, init is still included (it is idempotent
 * and re-applies the SPL approve if the user cleared it elsewhere) and the
 * delegation pins the real `init_id` read off the chain.
 *
 * CAPPED at the token level. `init` approves the authority PDA for u64::MAX,
 * which wallets show as "Unlimited". The same transaction then runs an SPL
 * `approveChecked` that lowers the allowance to the most every live delegation
 * on that mint can still take over its whole life, plus the new one (see
 * allowance.ts). A revoke that leaves other delegations lowers it again.
 *
 * ONE signature to revoke. `revokeDelegation` closes the delegation PDA;
 * `revokeSubscriptionAuthority` clears the SPL delegate. Both are signed by the
 * owner alone, so they go in one transaction. The authority is only revoked
 * when no other live delegation on the same mint depends on it — revoking it
 * would silently break every other mandate on that token.
 */
import { createNoopSigner, type Address, type Instruction } from '@solana/kit'
import { findAssociatedTokenPda, getApproveCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import {
  fetchDelegationsByDelegator,
  fetchMaybeRecurringDelegation,
  fetchMaybeSubscriptionAuthority,
  findRecurringDelegationPda,
  findSubscriptionAuthorityPda,
  getCreateRecurringDelegationOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getRevokeDelegationOverlayInstruction,
  getRevokeSubscriptionAuthorityOverlayInstructionAsync,
  getTransferRecurringOverlayInstructionAsync,
  UNKNOWN_INIT_ID,
} from '@solana/subscriptions'
import { allowanceFor, newGrantLifetime } from './allowance.js'
import { compileUnsigned, type Rpc } from './tx.js'

export const PROGRAM_ID = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44'
/** Custom program errors this app reacts to, from program/src/errors.rs. */
export const ERR = {
  DelegationExpired: 128,
  AmountExceedsPeriodLimit: 400, // 0x190
  DelegationNotStarted: 407,
} as const

export interface MandateTerms {
  owner: Address
  mint: Address
  delegatee: Address
  nonce: bigint
  amountPerPeriod: bigint
  periodLengthS: bigint
  /** 0 = start when the transaction lands (then expiryTs must be > 0). */
  startTs: bigint
  /** Unix seconds; 0 = never. */
  expiryTs: bigint
}

export interface GrantTx {
  transactionBase64: string
  delegationPda: Address
  authorityPda: Address
  userAta: Address
  /** true when the authority is created in this same transaction. */
  createsAuthority: boolean
  /** The token allowance the transaction leaves, in base units; null = left unlimited by init. */
  allowance: bigint | null
}

export async function userAtaOf(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  return ata
}

export async function delegationPdaOf(owner: Address, mint: Address, delegatee: Address, nonce: bigint) {
  const [authorityPda] = await findSubscriptionAuthorityPda({ user: owner, tokenMint: mint })
  const [delegationPda] = await findRecurringDelegationPda({
    subscriptionAuthority: authorityPda,
    delegator: owner,
    delegatee,
    nonce,
  })
  return { authorityPda, delegationPda }
}

/**
 * The instructions of a grant, without compiling. Split out so tests can sign
 * them with a local key exactly as Seed Vault would sign the compiled bytes.
 */
export async function grantInstructions(
  rpc: Rpc,
  t: MandateTerms,
  /** Signed by the owner in the same transaction, after the grant (a back permission's token account). */
  extra: Instruction[] = [],
): Promise<{
  instructions: Instruction[]
  delegationPda: Address
  authorityPda: Address
  userAta: Address
  createsAuthority: boolean
  allowance: bigint | null
}> {
  if (t.amountPerPeriod <= 0n) throw new Error('amountPerPeriod must be > 0')
  if (t.periodLengthS <= 0n || t.periodLengthS > 31_536_000n) throw new Error('periodLengthS out of program bounds')
  if (t.startTs === 0n && t.expiryTs === 0n) throw new Error('start-on-landing requires an expiry')

  const userAta = await userAtaOf(t.owner, t.mint)
  const ata = await rpc.getAccountInfo(userAta, { encoding: 'jsonParsed' }).send()
  if (!ata.value) throw new Error(`token account ${userAta} does not exist — the wallet holds none of ${t.mint}`)
  const parsed = (
    ata.value.data as unknown as {
      parsed?: { info?: { mint?: string; owner?: string; tokenAmount?: { decimals?: number } } }
    }
  ).parsed
  if (parsed?.info?.mint !== t.mint || parsed?.info?.owner !== t.owner) {
    throw new Error(`token account ${userAta} is not the ${t.mint} account of ${t.owner}`)
  }
  const decimals = parsed.info.tokenAmount?.decimals ?? 0

  const { authorityPda, delegationPda } = await delegationPdaOf(t.owner, t.mint, t.delegatee, t.nonce)
  const existing = await fetchMaybeSubscriptionAuthority(rpc, authorityPda)
  const createsAuthority = !existing.exists
  const initId = existing.exists ? (existing.data as unknown as { initId: bigint }).initId : UNKNOWN_INIT_ID

  const owner = createNoopSigner(t.owner)
  const init = await getInitSubscriptionAuthorityOverlayInstructionAsync({
    owner,
    tokenMint: t.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    userAta,
  })
  const create = await getCreateRecurringDelegationOverlayInstructionAsync({
    delegator: owner,
    delegatee: t.delegatee,
    tokenMint: t.mint,
    nonce: t.nonce,
    amountPerPeriod: t.amountPerPeriod,
    periodLengthS: t.periodLengthS,
    startTs: t.startTs,
    expiryTs: t.expiryTs,
    expectedSubscriptionAuthorityInitId: initId,
  })
  // Every live delegation on this mint, of any app, plus this one: the most the
  // authority can ever move. Unbounded (no expiry, or a plan subscription) = no cap.
  const nowS = BigInt(Math.floor(Date.now() / 1000))
  const allowance = allowanceFor(
    await listDelegations(rpc, t.owner),
    t.mint,
    nowS,
    newGrantLifetime(t.amountPerPeriod, t.periodLengthS, t.startTs, t.expiryTs, nowS),
  )
  const instructions: Instruction[] = [init, create]
  if (allowance !== null) instructions.push(capInstruction(userAta, t.mint, authorityPda, owner, allowance, decimals))
  instructions.push(...extra)
  return { instructions, delegationPda, authorityPda, userAta, createsAuthority, allowance }
}

/** SPL approveChecked: the authority PDA may move at most `amount` from the user's account, in total. */
function capInstruction(
  userAta: Address,
  mint: Address,
  authorityPda: Address,
  owner: ReturnType<typeof createNoopSigner>,
  amount: bigint,
  decimals: number,
): Instruction {
  return getApproveCheckedInstruction({ source: userAta, mint, delegate: authorityPda, owner, amount, decimals })
}

/** The single transaction the device signs to grant a mandate. */
export async function buildGrantTx(rpc: Rpc, t: MandateTerms, extra: Instruction[] = []): Promise<GrantTx> {
  const g = await grantInstructions(rpc, t, extra)
  return {
    transactionBase64: await compileUnsigned(rpc, t.owner, g.instructions),
    delegationPda: g.delegationPda,
    authorityPda: g.authorityPda,
    userAta: g.userAta,
    createsAuthority: g.createsAuthority,
    allowance: g.allowance,
  }
}

export async function revokeInstructions(
  owner: Address,
  delegationPda: Address,
  mint: Address,
  alsoRevokeAuthority: boolean,
  /** When other delegations stay: lower the allowance to what they can still take. */
  lowerTo?: { userAta: Address; authorityPda: Address; amount: bigint; decimals: number },
): Promise<Instruction[]> {
  const signer = createNoopSigner(owner)
  const ixs: Instruction[] = [
    getRevokeDelegationOverlayInstruction({ authority: signer, delegationAccount: delegationPda }),
  ]
  if (alsoRevokeAuthority) {
    ixs.push(
      await getRevokeSubscriptionAuthorityOverlayInstructionAsync({
        user: signer,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    )
  }
  if (!alsoRevokeAuthority && lowerTo) {
    ixs.push(capInstruction(lowerTo.userAta, mint, lowerTo.authorityPda, signer, lowerTo.amount, lowerTo.decimals))
  }
  return ixs
}

/**
 * One transaction that ends a mandate. The authority goes too when this is the
 * last live delegation on the mint, so the token account ends `delegate: none`.
 */
export async function buildRevokeTx(
  rpc: Rpc,
  owner: Address,
  delegationPda: Address,
  mint: Address,
): Promise<{ transactionBase64: string; revokesAuthority: boolean }> {
  const all = await listDelegations(rpc, owner)
  const others = all.filter((d) => d.mint === mint && d.address !== delegationPda)
  const revokesAuthority = others.length === 0
  let lowerTo: Parameters<typeof revokeInstructions>[4]
  if (!revokesAuthority) {
    const amount = allowanceFor(all, mint, BigInt(Math.floor(Date.now() / 1000)), 0n, delegationPda)
    const userAta = await userAtaOf(owner, mint)
    const ata = await readAta(rpc, userAta)
    const [authorityPda] = await findSubscriptionAuthorityPda({ user: owner, tokenMint: mint })
    // Only lower an allowance nuntius can see is on this authority, and never raise it here.
    if (
      amount !== null &&
      ata.delegate === authorityPda &&
      ata.delegatedAmount !== null &&
      amount < BigInt(ata.delegatedAmount)
    ) {
      lowerTo = { userAta, authorityPda, amount, decimals: ata.decimals ?? 0 }
    }
  }
  const ixs = await revokeInstructions(owner, delegationPda, mint, revokesAuthority, lowerTo)
  return { transactionBase64: await compileUnsigned(rpc, owner, ixs), revokesAuthority }
}

export async function pullInstruction(p: {
  delegatee: import('@solana/kit').TransactionSigner
  delegationPda: Address
  delegator: Address
  delegatorAta: Address
  receiverAta: Address
  mint: Address
  amount: bigint
}): Promise<Instruction> {
  return getTransferRecurringOverlayInstructionAsync({
    amount: p.amount,
    delegatee: p.delegatee,
    delegationPda: p.delegationPda,
    delegator: p.delegator,
    delegatorAta: p.delegatorAta,
    receiverAta: p.receiverAta,
    tokenMint: p.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
}

/** A delegation as the app shows it, whoever the delegatee is. */
export interface DelegationView {
  address: Address
  kind: 'fixed' | 'recurring' | 'subscription'
  delegator: Address
  delegatee: Address
  mint: Address | null
  /** Recurring only. */
  amountPerPeriod: string | null
  amountPulledInPeriod: string | null
  currentPeriodStartTs: number | null
  periodLengthS: number | null
  expiryTs: number | null
  /** Fixed only: what is left of the total. */
  amount: string | null
}

/**
 * Every delegation the wallet has granted through the program, to anyone.
 * This is the guard's source of truth: it is not limited to delegations
 * nuntius created. Uses getProgramAccounts with a delegator memcmp.
 */
export async function listDelegations(rpc: Rpc, owner: Address): Promise<DelegationView[]> {
  const all = await fetchDelegationsByDelegator(rpc as never, owner, PROGRAM_ID as Address)
  return all.map((d) => {
    const data = d.data as unknown as Record<string, unknown> & { header: { delegator: Address; delegatee: Address } }
    const n = (k: string) => (typeof data[k] === 'bigint' ? Number(data[k] as bigint) : null)
    const s = (k: string) => (typeof data[k] === 'bigint' ? (data[k] as bigint).toString() : null)
    return {
      address: d.address,
      kind: d.kind,
      delegator: data.header.delegator,
      delegatee: data.header.delegatee,
      mint: (data.mint as Address | undefined) ?? null,
      amountPerPeriod: d.kind === 'recurring' ? s('amountPerPeriod') : null,
      amountPulledInPeriod: d.kind === 'recurring' ? s('amountPulledInPeriod') : null,
      currentPeriodStartTs: d.kind === 'recurring' ? n('currentPeriodStartTs') : null,
      periodLengthS: d.kind === 'recurring' ? n('periodLengthS') : null,
      expiryTs: n('expiryTs'),
      amount: d.kind === 'fixed' ? s('amount') : null,
    }
  })
}

export interface RecurringState {
  exists: boolean
  delegator?: Address
  delegatee?: Address
  mint?: Address
  amountPerPeriod?: bigint
  amountPulledInPeriod?: bigint
  currentPeriodStartTs?: bigint
  periodLengthS?: bigint
  expiryTs?: bigint
}

export async function readRecurring(rpc: Rpc, delegationPda: Address): Promise<RecurringState> {
  const acct = await fetchMaybeRecurringDelegation(rpc, delegationPda)
  if (!acct.exists) return { exists: false }
  const d = acct.data
  return {
    exists: true,
    delegator: d.header.delegator,
    delegatee: d.header.delegatee,
    mint: d.mint,
    amountPerPeriod: d.amountPerPeriod,
    amountPulledInPeriod: d.amountPulledInPeriod,
    currentPeriodStartTs: d.currentPeriodStartTs,
    periodLengthS: d.periodLengthS,
    expiryTs: d.expiryTs,
  }
}

/**
 * What the program will allow right now. The period advances lazily on the
 * next transfer, so the stored `amountPulledInPeriod` is stale once the period
 * has rolled: compute the effective window from the clock instead of trusting
 * it (mirrors program/src/instructions/helpers/transfer_validation.rs).
 */
export function effectiveWindow(
  s: Pick<
    RecurringState,
    'amountPerPeriod' | 'amountPulledInPeriod' | 'currentPeriodStartTs' | 'periodLengthS' | 'expiryTs'
  >,
  nowS: bigint,
): {
  periodStart: bigint
  periodIndex: bigint
  used: bigint
  remaining: bigint
  nextResetTs: bigint
  expired: boolean
} {
  const cap = s.amountPerPeriod ?? 0n
  const start = s.currentPeriodStartTs ?? 0n
  const len = s.periodLengthS ?? 1n
  const expiry = s.expiryTs ?? 0n
  // Expiry is a hard stop on transfers (program 0.4.0+): nothing is pullable after it.
  if (expiry > 0n && nowS >= expiry) {
    return { periodStart: start, periodIndex: -1n, used: 0n, remaining: 0n, nextResetTs: 0n, expired: true }
  }
  if (nowS < start) {
    return { periodStart: start, periodIndex: -1n, used: 0n, remaining: 0n, nextResetTs: start, expired: false }
  }
  const elapsed = (nowS - start) / len
  const periodStart = start + elapsed * len
  const used = elapsed === 0n ? (s.amountPulledInPeriod ?? 0n) : 0n
  const remaining = cap > used ? cap - used : 0n
  return { periodStart, periodIndex: elapsed, used, remaining, nextResetTs: periodStart + len, expired: false }
}

/** SPL delegate fields on a token account — the revoke proof. */
export async function readAta(
  rpc: Rpc,
  ata: Address,
): Promise<{
  exists: boolean
  delegate: string | null
  delegatedAmount: string | null
  amount: string | null
  decimals: number | null
  mint: string | null
  owner: string | null
}> {
  const info = await rpc.getAccountInfo(ata, { encoding: 'jsonParsed' }).send()
  if (!info.value)
    return {
      exists: false,
      delegate: null,
      delegatedAmount: null,
      amount: null,
      decimals: null,
      mint: null,
      owner: null,
    }
  const i = (
    info.value.data as unknown as {
      parsed?: {
        info?: {
          delegate?: string
          delegatedAmount?: { amount?: string }
          tokenAmount?: { amount?: string; decimals?: number }
          mint?: string
          owner?: string
        }
      }
    }
  ).parsed?.info
  return {
    exists: true,
    delegate: i?.delegate ?? null,
    delegatedAmount: i?.delegatedAmount?.amount ?? null,
    amount: i?.tokenAmount?.amount ?? null,
    decimals: i?.tokenAmount?.decimals ?? null,
    mint: i?.mint ?? null,
    owner: i?.owner ?? null,
  }
}
