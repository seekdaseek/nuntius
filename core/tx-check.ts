/**
 * The app's own check of a server-built transaction, before Seed Vault opens.
 *
 * The server builds every grant, revoke and launch. A compromised server could
 * hand the phone a transaction that says something other than the screen. This
 * decodes the message and accepts it only if it does exactly what the user
 * typed and saw: the wallet pays the fee and is the only signer we expect,
 * every instruction's program is on the allowlist for this action, and the
 * values that matter (mint, amounts, period, expiry, delegatee, the token
 * approval's delegate and amount) are the ones on screen. Anything else that
 * could move tokens or SOL (a transfer, an unknown program, another fee payer)
 * is refused. Pure: no network, so it is unit-tested on the server's own
 * transactions (core/tx-check.test.ts, server/src/tx-check.localnet.test.ts).
 */
import {
  getAddressEncoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getU64Encoder,
  getUtf8Encoder,
  type Address,
} from '@solana/kit'

export const PROGRAMS = {
  subscriptions: 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  system: '11111111111111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
} as const

/** The one sentence the user sees when a transaction is refused. */
export const MISMATCH = 'This transaction did not match what you approved on screen, so it was not sent to Seed Vault.'

export class TxMismatch extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(MISMATCH)
    this.name = 'TxMismatch'
    this.reason = reason
  }
}

export interface GrantExpect {
  kind: 'grant'
  wallet: string
  mint: string
  decimals: number
  /** The nuntius executor this build trusts: every grant names it as delegatee. */
  delegatee: string
  amountPerPeriod: bigint
  periodLengthS: number
  untilDays: number
  nowS: number
  /**
   * What the screen said Seed Vault will show: a total in base units, null for
   * "no limit" (no approval in the transaction), undefined when the screen
   * named only this permission's own total.
   */
  shownAllowance: bigint | null | undefined
  /** A back permission: the launch token whose account the grant creates. */
  baseMint?: string
}

export interface RevokeExpect {
  kind: 'revoke'
  wallet: string
  delegationPda: string
  /** The permission's mint, from the list. */
  mint: string | null
  /** That token account's allowance now, base units, when the list reports it. */
  allowance?: bigint | null
}

export interface LaunchExpect {
  kind: 'launch'
  wallet: string
  baseMint: string
  quoteMint: string
}

export type Expect = GrantExpect | RevokeExpect | LaunchExpect

/** One instruction with its program and accounts resolved to addresses. */
interface Ix {
  program: string
  accounts: string[]
  data: Uint8Array
}

const u64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true)
const i64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigInt64(at, true)

function fail(reason: string): never {
  throw new TxMismatch(reason)
}
function same(a: string | undefined, b: string, what: string) {
  if (a !== b) fail(`${what}: ${a ?? 'missing'} is not ${b}`)
}

export async function authorityPda(wallet: string, mint: string): Promise<string> {
  const a = getAddressEncoder()
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAMS.subscriptions as Address,
    seeds: [getUtf8Encoder().encode('SubscriptionAuthority'), a.encode(wallet as Address), a.encode(mint as Address)],
  })
  return pda
}

export async function delegationPda(authority: string, wallet: string, delegatee: string, nonce: bigint) {
  const a = getAddressEncoder()
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAMS.subscriptions as Address,
    seeds: [
      getUtf8Encoder().encode('delegation'),
      a.encode(authority as Address),
      a.encode(wallet as Address),
      a.encode(delegatee as Address),
      getU64Encoder().encode(nonce),
    ],
  })
  return pda
}

export async function ataOf(owner: string, mint: string): Promise<string> {
  const a = getAddressEncoder()
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAMS.ata as Address,
    seeds: [a.encode(owner as Address), a.encode(PROGRAMS.token as Address), a.encode(mint as Address)],
  })
  return pda
}

interface Legacy {
  header: { numSignerAccounts: number }
  staticAccounts: string[]
  instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[]
  addressTableLookups?: unknown[]
}

/** Decodes a base64 wire transaction into its signers and resolved instructions. */
export function decodeTx(base64: string): { feePayer: string; signers: string[]; ixs: Ix[] } {
  let message: Legacy
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64))
    const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
    // The server builds v0 messages; the v1 format (SIMD-0385) is not expected.
    if (m.version !== 0 && m.version !== 'legacy') throw new Error('version')
    message = m as unknown as Legacy
  } catch {
    fail('not a transaction')
  }
  if ((message.addressTableLookups ?? []).length > 0) fail('address lookup tables are not expected')
  const keys = message.staticAccounts
  const nSigners = message.header.numSignerAccounts
  const ixs = (message.instructions ?? []).map((ix) => {
    const program = keys[ix.programAddressIndex]
    if (!program) fail('instruction program out of range')
    const accounts = (ix.accountIndices ?? []).map((i) => keys[i] ?? fail('account index out of range'))
    return { program, accounts, data: new Uint8Array(ix.data ?? new Uint8Array()) }
  })
  return { feePayer: keys[0] ?? fail('no fee payer'), signers: keys.slice(0, nSigners), ixs }
}

/** Throws TxMismatch unless the transaction does exactly what `e` describes. */
export async function checkTransaction(base64: string, e: Expect): Promise<void> {
  const { feePayer, signers, ixs } = decodeTx(base64)
  same(feePayer, e.wallet, 'fee payer')
  if (e.kind === 'launch') return checkLaunch(signers, ixs, e)
  if (signers.length !== 1) fail(`${signers.length} signers, expected only the wallet`)
  if (e.kind === 'grant') return checkGrant(ixs, e)
  return checkRevoke(ixs, e)
}

async function checkGrant(ixs: Ix[], e: GrantExpect) {
  const authority = await authorityPda(e.wallet, e.mint)
  const userAta = await ataOf(e.wallet, e.mint)
  const queue = [...ixs]
  const next = (program: string, disc: number, what: string): Ix => {
    const ix = queue.shift() ?? fail(`${what} missing`)
    same(ix.program, program, `${what} program`)
    if (ix.data[0] !== disc) fail(`${what}: unexpected instruction ${ix.data[0]}`)
    return ix
  }

  // 1. initSubscriptionAuthority: owner, authority, mint, owner's account, system, token.
  //    No separate payer account: the owner pays the rent.
  const init = next(PROGRAMS.subscriptions, 0, 'init')
  if (init.data.length !== 1 || init.accounts.length !== 6) fail('init: unexpected layout')
  same(init.accounts[0], e.wallet, 'init owner')
  same(init.accounts[1], authority, 'init authority')
  same(init.accounts[2], e.mint, 'init mint')
  same(init.accounts[3], userAta, 'init token account')
  same(init.accounts[4], PROGRAMS.system, 'init system program')
  same(init.accounts[5], PROGRAMS.token, 'init token program')

  // 2. createRecurringDelegation: delegator, authority, delegation, delegatee, system (the delegator pays).
  const create = next(PROGRAMS.subscriptions, 2, 'delegation')
  if (create.data.length !== 49 || create.accounts.length !== 5) fail('delegation: unexpected layout')
  const nonce = u64(create.data, 1)
  const amount = u64(create.data, 9)
  const period = u64(create.data, 17)
  const start = i64(create.data, 25)
  const expiry = i64(create.data, 33)
  same(create.accounts[0], e.wallet, 'delegator')
  same(create.accounts[1], authority, 'delegation authority')
  same(create.accounts[3], e.delegatee, 'delegatee')
  same(create.accounts[2], await delegationPda(authority, e.wallet, e.delegatee, nonce), 'delegation account')
  same(create.accounts[4], PROGRAMS.system, 'delegation system program')
  if (amount !== e.amountPerPeriod) fail(`amount per period ${amount} is not ${e.amountPerPeriod}`)
  if (period !== BigInt(e.periodLengthS)) fail(`period ${period} is not ${e.periodLengthS}`)
  if (start !== 0n) fail('a start time was set')
  // The server sets expiry = its clock + untilDays; allow an hour of clock skew or a later rebuild.
  const want = BigInt(e.nowS + e.untilDays * 86_400)
  if (expiry < want - 3_600n || expiry > want + 3_600n) fail(`expiry ${expiry} is not about ${want}`)

  // 3. The token approval, when the screen showed a total.
  if (queue[0]?.program === PROGRAMS.token) {
    const ap = next(PROGRAMS.token, 13, 'approval')
    if (ap.data.length !== 10 || ap.accounts.length !== 4) fail('approval: unexpected layout')
    same(ap.accounts[0], userAta, 'approval source')
    same(ap.accounts[1], e.mint, 'approval mint')
    same(ap.accounts[2], authority, 'approval delegate')
    same(ap.accounts[3], e.wallet, 'approval owner')
    if (ap.data[9] !== e.decimals) fail('approval decimals')
    const total = u64(ap.data, 1)
    if (e.shownAllowance === null) fail('an approval the screen did not show')
    if (e.shownAllowance !== undefined && total !== e.shownAllowance)
      fail(`approval ${total} is not the ${e.shownAllowance} on screen`)
    // Not shown: it must at least cover this permission's own lifetime, as the server computes it.
    if (e.shownAllowance === undefined && total < amount) fail('approval below one period')
  } else if (e.shownAllowance !== null && e.shownAllowance !== undefined) {
    fail('the approval the screen showed is missing')
  }

  // 4. A back permission: the backer's own account for the launch token, created idempotently.
  if (e.baseMint) {
    const ix = next(PROGRAMS.ata, 1, 'token account')
    if (ix.data.length !== 1 || ix.accounts.length !== 6) fail('token account: unexpected layout')
    same(ix.accounts[0], e.wallet, 'token account payer')
    same(ix.accounts[1], await ataOf(e.wallet, e.baseMint), 'token account address')
    same(ix.accounts[2], e.wallet, 'token account owner')
    same(ix.accounts[3], e.baseMint, 'token account mint')
    same(ix.accounts[4], PROGRAMS.system, 'token account system program')
    same(ix.accounts[5], PROGRAMS.token, 'token account token program')
  }
  if (queue.length > 0) fail(`unexpected ${queue[0]!.program} instruction`)
}

async function checkRevoke(ixs: Ix[], e: RevokeExpect) {
  const [rv, ...rest] = ixs
  if (!rv) fail('no instructions')
  same(rv.program, PROGRAMS.subscriptions, 'revoke program')
  if (rv.data[0] !== 3 || rv.data.length !== 1 || rv.accounts.length !== 2) fail('revoke: unexpected instruction')
  same(rv.accounts[0], e.wallet, 'revoke authority')
  same(rv.accounts[1], e.delegationPda, 'revoked permission')
  if (rest.length > 1) fail('more than one instruction after the revoke')
  const after = rest[0]
  if (!after) return
  // Either the token-level delegate goes too (last permission on the mint), or the approval is trimmed.
  const mint =
    after.program === PROGRAMS.subscriptions
      ? after.accounts[2]
      : after.program === PROGRAMS.token
        ? after.accounts[1]
        : undefined
  if (!mint) fail(`unexpected ${after.program} instruction`)
  if (e.mint) same(mint, e.mint, 'mint')
  const authority = await authorityPda(e.wallet, mint)
  const userAta = await ataOf(e.wallet, mint)
  if (after.program === PROGRAMS.subscriptions) {
    // user, token account, mint, token program, authority; no other rent receiver than the user.
    if (after.data[0] !== 14 || after.data.length !== 1 || after.accounts.length !== 5)
      fail('unexpected instruction after the revoke')
    same(after.accounts[0], e.wallet, 'authority revoke user')
    same(after.accounts[1], userAta, 'authority revoke token account')
    same(after.accounts[3], PROGRAMS.token, 'authority revoke token program')
    same(after.accounts[4], authority, 'authority revoke authority')
    return
  }
  if (after.data[0] !== 13 || after.data.length !== 10 || after.accounts.length !== 4)
    fail('unexpected token instruction after the revoke')
  same(after.accounts[0], userAta, 'trim source')
  same(after.accounts[2], authority, 'trim delegate')
  same(after.accounts[3], e.wallet, 'trim owner')
  const total = u64(after.data, 1)
  // A trim lowers the allowance; it never raises it above what the list reports.
  if (e.allowance !== undefined && e.allowance !== null && total > e.allowance)
    fail(`trim to ${total} is above the current ${e.allowance}`)
}

/** DBC instructions a launch may contain (Anchor discriminators): create config, create pool. */
const DBC_LAUNCH = new Set(['c9cff3724b6f2fbd', '8c55d7b06636684f'])
const hex = (d: Uint8Array) => Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')

function checkLaunch(signers: string[], ixs: Ix[], e: LaunchExpect) {
  // The wallet plus the two fresh keys the server signs for: the config and the token's mint.
  if (signers.length !== 3 || !signers.includes(e.baseMint)) fail('unexpected signers')
  let pools = 0
  for (const ix of ixs) {
    if (ix.program === PROGRAMS.computeBudget) {
      if (ix.data[0] !== 2 && ix.data[0] !== 3) fail('unexpected compute budget instruction')
      continue
    }
    same(ix.program, PROGRAMS.dbc, 'launch program')
    if (!DBC_LAUNCH.has(hex(ix.data))) fail(`unexpected launch instruction ${hex(ix.data)}`)
    if (!ix.accounts.includes(e.wallet)) fail('a launch instruction without the wallet as creator')
    if (ix.accounts.includes(e.baseMint)) {
      pools++
      if (!ix.accounts.includes(e.quoteMint)) fail('launch quote mint')
    }
  }
  if (pools !== 1) fail('expected one pool for the token')
}

/** The pinned mainnet tokens the app offers: symbol -> mint and decimals. */
export const MINTS: Record<string, { mint: string; decimals: number }> = {
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  SKR: { mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3', decimals: 6 },
}

const PERIOD_S: Record<string, number> = { hour: 3_600, day: 86_400, week: 604_800, '30days': 2_592_000 }

/** "0.05" at 6 decimals -> 50000n; null when it is not a plain decimal amount. */
export function baseUnits(text: string, decimals: number): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,18}))?$/.exec(text.trim())
  if (!m || (m[2]?.length ?? 0) > decimals) return null
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0')
}

/**
 * What a grant must say, from what the user typed and the screen showed. Only
 * the pinned tokens and the executor this build was given are accepted.
 */
export function expectGrant(p: {
  wallet: string
  symbol: string
  amount: string
  period: string
  untilDays: number
  executor: string | null
  /** The total the screen showed ("Seed Vault will show X"): a decimal string, null for no limit, undefined if not shown. */
  shownAllowance: string | null | undefined
  nowMs: number
  baseMint?: string
}): GrantExpect {
  const t = MINTS[p.symbol] ?? fail(`${p.symbol} is not a token this build knows`)
  if (!p.executor) fail('this build has no executor address')
  const amountPerPeriod = baseUnits(p.amount, t.decimals) ?? fail('amount')
  const periodLengthS = PERIOD_S[p.period] ?? fail('period')
  const shown = p.shownAllowance
  return {
    kind: 'grant',
    wallet: p.wallet,
    mint: t.mint,
    decimals: t.decimals,
    delegatee: p.executor,
    amountPerPeriod,
    periodLengthS,
    untilDays: p.untilDays,
    nowS: Math.floor(p.nowMs / 1000),
    shownAllowance:
      shown === undefined || shown === null ? shown : (baseUnits(shown, t.decimals) ?? fail('shown total')),
    ...(p.baseMint ? { baseMint: p.baseMint } : {}),
  }
}
