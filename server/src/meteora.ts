/**
 * Subscription launches on Meteora: the weekly buy, the launch read-out, and the launch
 * transaction. Meteora's programs are used as deployed, through their MIT SDKs
 * (@meteora-ag/dynamic-bonding-curve-sdk, @meteora-ag/cp-amm-sdk): the SDKs' own IDL
 * encoders build the instructions. None of Meteora's program source is fetched, built
 * or vendored.
 *
 * THE BUY is one transaction the executor signs:
 *   compute budget -> transferRecurring (the backer's capped pull, into the executor's
 *   quote account) -> swap exact-in of exactly that amount, paid from that account, with
 *   the bought tokens written straight to the backer's own token account.
 * Exact-in either spends all of its input or fails, so the executor holds the same
 * quote and base balances after a buy as before it; if the swap cannot meet its
 * minimum-out, the whole transaction fails and nothing is pulled.
 *
 * THE ROUTE follows the token: the bonding curve (DBC) until it fills, then nothing while
 * it migrates, then the DAMM v2 pool it migrated to. That pool is the one the DBC program
 * creates at migration, derived from the curve's migration config (canonicalDammPool); a
 * pool anyone else opens for the same pair is never bought. Near the end of the curve the
 * buy is cut to what the curve still takes, because an exact-in that would cross the
 * migration threshold fails.
 */
import { ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'
import BN from 'bn.js'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import * as CPAMM from '@meteora-ag/cp-amm-sdk'
import { AccountRole, type Address, type Instruction } from '@solana/kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { isHelius, programAccountsV2, type Fetch } from './program-accounts.js'

export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
export const DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'
const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ADDRESS)
if (DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58() !== DBC_PROGRAM) throw new Error('DBC SDK program id changed')
if (CPAMM.CP_AMM_PROGRAM_ID.toBase58() !== DAMM_V2_PROGRAM) throw new Error('DAMM v2 SDK program id changed')

export type Route = 'dbc' | 'damm_v2'
export const DEFAULT_SLIPPAGE_BPS = 200
/**
 * Measured in the spike's mainnet simulations (1 Oct): pull 8,661 CU; swap 29,908 CU on a
 * DBC curve (whole buy 38,869) and 16,650 CU on DAMM v2 (25,611). 120,000 is about 3x the
 * heavier route; the priority fee is charged on the limit, so it is not set higher.
 */
export const BUY_BUDGET = { unitLimit: 120_000, microLamportsPerUnit: 50_000 }

/** The accounts a buy needs from a pool, read off the chain. */
export type SwapAccounts =
  | {
      route: 'dbc'
      pool: string
      config: string
      baseVault: string
      quoteVault: string
      baseMint: string
      quoteMint: string
    }
  | {
      route: 'damm_v2'
      pool: string
      tokenAMint: string
      tokenBMint: string
      tokenAVault: string
      tokenBVault: string
      baseMint: string
      quoteMint: string
    }

/** What the app and the public endpoint show about a launch. */
export interface LaunchState {
  route: Route | 'migrating'
  pool: string
  dammPool: string | null
  baseMint: string
  quoteMint: string
  baseDecimals: number
  /** Why a back permission cannot buy this pool, in one sentence; null when it can. */
  refusal: string | null
  /** Quote raised on the curve, and the migration threshold, in quote base units. */
  quoteRaised: string
  threshold: string
  /** 0..10000 */
  progressBps: number
  swap: SwapAccounts | null
}

const pk = (a: string) => new PublicKey(a)

/** A web3.js instruction as a @solana/kit one. */
export function toKit(ix: TransactionInstruction): Instruction {
  return {
    programAddress: ix.programId.toBase58() as Address,
    accounts: ix.keys.map((k) => ({
      address: k.pubkey.toBase58() as Address,
      role: k.isSigner
        ? k.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : k.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: new Uint8Array(ix.data),
  }
}

export async function ataOf(owner: string, mint: string): Promise<string> {
  const [a] = await findAssociatedTokenPda({
    owner: owner as Address,
    mint: mint as Address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  return a
}

// The SDKs' programs are only used to encode; their connection is never called when composing.
let programs: { dbc: ReturnType<typeof DBC.createDbcProgram>['program']; amm: CPAMM.CpAmm['_program'] } | null = null
function encoders(conn: Connection) {
  programs ??= { dbc: DBC.createDbcProgram(conn, 'confirmed').program, amm: new CPAMM.CpAmm(conn)._program }
  return programs
}

/** The swap leg: exact-in, paid by the executor from its quote account, output to the backer's account. */
export async function swapInstruction(
  conn: Connection,
  s: SwapAccounts,
  p: { delegatee: string; backerBaseAta: string; amountIn: bigint; minimumOut: bigint },
): Promise<Instruction> {
  const { dbc, amm } = encoders(conn)
  const inputTokenAccount = pk(await ataOf(p.delegatee, s.quoteMint))
  const args = {
    amount0: new BN(p.amountIn.toString()),
    amount1: new BN(p.minimumOut.toString()),
    swapMode: 0 /* ExactIn */,
  }
  if (s.route === 'dbc') {
    const ix = await dbc.methods
      .swap2(args)
      .accountsPartial({
        poolAuthority: DBC.deriveDbcPoolAuthority(),
        config: pk(s.config),
        pool: pk(s.pool),
        inputTokenAccount,
        outputTokenAccount: pk(p.backerBaseAta),
        baseVault: pk(s.baseVault),
        quoteVault: pk(s.quoteVault),
        baseMint: pk(s.baseMint),
        quoteMint: pk(s.quoteMint),
        payer: pk(p.delegatee),
        tokenBaseProgram: TOKEN_PROGRAM,
        tokenQuoteProgram: TOKEN_PROGRAM,
        referralTokenAccount: null,
        eventAuthority: DBC.deriveDbcEventAuthority(),
        program: pk(DBC_PROGRAM),
      })
      .instruction()
    return toKit(ix)
  }
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], pk(DAMM_V2_PROGRAM))
  const ix = await amm.methods
    .swap2(args)
    .accountsPartial({
      poolAuthority: CPAMM.derivePoolAuthority(),
      pool: pk(s.pool),
      inputTokenAccount,
      outputTokenAccount: pk(p.backerBaseAta),
      tokenAVault: pk(s.tokenAVault),
      tokenBVault: pk(s.tokenBVault),
      tokenAMint: pk(s.tokenAMint),
      tokenBMint: pk(s.tokenBMint),
      payer: pk(p.delegatee),
      tokenAProgram: TOKEN_PROGRAM,
      tokenBProgram: TOKEN_PROGRAM,
      referralTokenAccount: null,
      eventAuthority,
      program: pk(DAMM_V2_PROGRAM),
    })
    .instruction()
  return toKit(ix)
}

export function budgetInstructions(b = BUY_BUDGET): Instruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: b.unitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: b.microLamportsPerUnit }),
  ].map(toKit)
}

/** minimum-out = quoted out x (1 - slippage). */
export function minimumOut(quotedOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) throw new Error('slippage out of range')
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n
}

export type BuyQuote =
  | { kind: 'buy'; amountIn: bigint; quotedOut: bigint; minimumOut: bigint }
  | { kind: 'wait'; reason: 'migrating' | 'nothing_left' }

/**
 * The quote for one period's buy. On the curve, an exact-in that would cross the
 * migration threshold fails, so the amount is cut to what the curve still takes
 * (partial-fill quote); the pull then takes only that much.
 */
export function quoteDbc(
  pool: DBC.VirtualPool,
  config: DBC.PoolConfig,
  amount: bigint,
  slippageBps: number,
  nowS: number,
  slot: number,
): BuyQuote {
  const ps = (pool as unknown as { poolState: { quoteReserve: BN } }).poolState
  if (ps.quoteReserve.gte(config.migrationQuoteThreshold)) return { kind: 'wait', reason: 'migrating' }
  const currentPoint = new BN(config.activationType === 1 ? nowS : slot)
  let amountIn = amount
  let out: BN
  try {
    out = DBC.swapQuoteExactIn(
      pool,
      config,
      false,
      new BN(amount.toString()),
      0,
      false,
      currentPoint,
      false,
    ).outputAmount
  } catch {
    const partial = DBC.swapQuotePartialFill(
      pool,
      config,
      false,
      new BN(amount.toString()),
      0,
      false,
      currentPoint,
      false,
    )
    amountIn = BigInt(partial.includedFeeInputAmount.toString())
    if (amountIn <= 0n) return { kind: 'wait', reason: 'nothing_left' }
    out = DBC.swapQuoteExactIn(
      pool,
      config,
      false,
      new BN(amountIn.toString()),
      0,
      false,
      currentPoint,
      false,
    ).outputAmount
  }
  const quotedOut = BigInt(out.toString())
  return { kind: 'buy', amountIn, quotedOut, minimumOut: minimumOut(quotedOut, slippageBps) }
}

/**
 * The quote for one buy on DAMM v2. The decimals only feed the SDK's price-impact figure,
 * never the amounts (meteora.test.ts checks that), but they are passed as they are.
 */
export function quoteDamm(
  conn: Connection,
  state: CPAMM.PoolState,
  quoteMint: string,
  amount: bigint,
  slippageBps: number,
  nowS: number,
  slot: number,
  decimals: { base: number; quote: number } = { base: 6, quote: 6 },
): BuyQuote {
  const quoteIsA = state.tokenAMint.toBase58() === quoteMint
  const q = new CPAMM.CpAmm(conn).getQuote2({
    inputTokenMint: pk(quoteMint),
    slippage: 0,
    currentPoint: new BN(Number(state.activationType) === 1 ? nowS : slot),
    poolState: state,
    tokenADecimal: quoteIsA ? decimals.quote : decimals.base,
    tokenBDecimal: quoteIsA ? decimals.base : decimals.quote,
    hasReferral: false,
    swapMode: CPAMM.SwapMode.ExactIn,
    amountIn: new BN(amount.toString()),
  })
  const quotedOut = BigInt(q.outputAmount.toString())
  return { kind: 'buy', amountIn: amount, quotedOut, minimumOut: minimumOut(quotedOut, slippageBps) }
}

/**
 * The DAMM v2 pool a curve migrates into: the address the DBC program creates at
 * migration, from the DAMM v2 config its migration fee option names (the SDK's
 * migrateToDammV2 derives it the same way). Anyone can open another DAMM v2 pool for the
 * same pair, thin or skewed; only this one is ever bought.
 */
export function canonicalDammPool(migrationFeeOption: number, baseMint: string, quoteMint: string): string {
  const config = DBC.DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption]
  if (!config) throw new Error(`unknown migration fee option ${migrationFeeOption}`)
  return DBC.deriveDammV2PoolAddress(config, pk(baseMint), pk(quoteMint)).toBase58()
}

/** A pool "Back a launch" cannot buy, with the sentence that says why. */
export class UnsupportedLaunch extends Error {}

/** The DBC account types that are not a plain virtual pool (IDL discriminators). */
const TRANSFER_HOOK_POOL = Buffer.from([237, 219, 184, 23, 42, 189, 169, 35])

/** What the refusal check reads from a curve's config and pool. */
export interface CurveFacts {
  tokenType: number
  quoteTokenFlag: number
  migrationOption: number
  baseFeeMode: number
  /** Rate limiter only: fee increment (bps), max duration (points), reference amount. */
  firstFactor: number
  secondFactor: bigint
  thirdFactor: bigint
  activationType: number
  activationPoint: bigint
}

/**
 * Why "Back a launch" cannot buy this curve, or null. The buy is built for classic SPL
 * Token on both sides (the swap passes the SPL Token program for each), for a curve that
 * migrates to DAMM v2 (the route it follows), and without the instructions sysvar that a
 * curve's rate limiter needs while it is active.
 */
export function backRefusal(c: CurveFacts, nowS: number, slot: number): string | null {
  if (c.tokenType !== 0) return 'This launch’s token uses Token-2022, which nuntius cannot buy yet.'
  if (c.quoteTokenFlag !== 0) return 'This launch is priced in a Token-2022 token, which nuntius cannot pull.'
  if (c.migrationOption !== 1)
    return 'This launch moves to DAMM v1 when its curve fills; nuntius follows launches to DAMM v2 only.'
  const limiterOn = !(c.firstFactor === 0 && c.secondFactor === 0n && c.thirdFactor === 0n)
  if (c.baseFeeMode === 2 && limiterOn) {
    const end = c.activationPoint + c.secondFactor
    const now = BigInt(c.activationType === 1 ? nowS : slot)
    if (now <= end) {
      const secondsLeft = c.activationType === 1 ? Number(end - now) : Math.ceil(Number(end - now) * 0.4)
      return `This launch limits buys in its opening window. Back it after that ends, in about ${Math.max(1, Math.ceil(secondsLeft / 60))} minutes.`
    }
  }
  return null
}

/** Reads a launch: curve progress, and which pool a buy goes to now. */
export async function readLaunch(
  conn: Connection,
  pool: string,
  knownDammPool: string | null = null,
): Promise<LaunchState & { raw: { dbc?: { pool: DBC.VirtualPool; config: DBC.PoolConfig }; damm?: CPAMM.PoolState } }> {
  const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
  const vp = await client.state.getPool(pool).catch(() => null)
  if (!vp) {
    const acc = await conn.getAccountInfo(pk(pool))
    if (acc && acc.owner.toBase58() === DBC_PROGRAM && acc.data.subarray(0, 8).equals(TRANSFER_HOOK_POOL))
      throw new UnsupportedLaunch('This launch’s token has a transfer hook, which nuntius cannot buy.')
    throw new Error(`no DBC pool at ${pool}`)
  }
  const ps = (
    vp as unknown as {
      poolState: {
        config: PublicKey
        baseMint: PublicKey
        baseVault: PublicKey
        quoteVault: PublicKey
        quoteReserve: BN
        isMigrated: number
        activationPoint: BN
      }
    }
  ).poolState
  const config = await client.state.getPoolConfig(ps.config)
  if (!config) throw new Error(`no DBC config for ${pool}`)
  const quoteMint = config.quoteMint.toBase58()
  const baseMint = ps.baseMint.toBase58()
  const fee = config.poolFees.baseFee
  const slot = await conn.getSlot('confirmed')
  const refusal = backRefusal(
    {
      tokenType: Number(config.tokenType),
      quoteTokenFlag: Number(config.quoteTokenFlag),
      migrationOption: Number(config.migrationOption),
      baseFeeMode: Number(fee.baseFeeMode),
      firstFactor: Number(fee.firstFactor),
      secondFactor: BigInt(fee.secondFactor.toString()),
      thirdFactor: BigInt(fee.thirdFactor.toString()),
      activationType: Number(config.activationType),
      activationPoint: BigInt(ps.activationPoint.toString()),
    },
    Math.floor(Date.now() / 1000),
    slot,
  )
  const threshold = config.migrationQuoteThreshold
  const raised = BN.min(ps.quoteReserve, threshold)
  const progressBps = threshold.isZero() ? 0 : raised.muln(10_000).div(threshold).toNumber()
  const base = {
    pool,
    baseMint,
    quoteMint,
    baseDecimals: Number(config.tokenDecimal),
    refusal,
    quoteRaised: ps.quoteReserve.toString(),
    threshold: threshold.toString(),
    progressBps,
  }
  if (ps.quoteReserve.lt(threshold)) {
    return {
      ...base,
      route: 'dbc',
      dammPool: null,
      swap: {
        route: 'dbc',
        pool,
        config: ps.config.toBase58(),
        baseVault: ps.baseVault.toBase58(),
        quoteVault: ps.quoteVault.toBase58(),
        baseMint,
        quoteMint,
      },
      raw: { dbc: { pool: vp, config } },
    }
  }
  if (Number(ps.isMigrated) !== 1 || Number(config.migrationOption) !== 1)
    return { ...base, route: 'migrating', dammPool: null, swap: null, raw: {} }
  // Migrated: only the pool the DBC program created at migration. A stored pool that is
  // not that one is refused outright, never bought.
  const dammPool = canonicalDammPool(Number(config.migrationFeeOption), baseMint, quoteMint)
  if (knownDammPool && knownDammPool !== dammPool)
    throw new Error(`stored DAMM v2 pool ${knownDammPool} is not the curve's migrated pool ${dammPool}`)
  const a = await new CPAMM.CpAmm(conn).fetchPoolState(pk(dammPool)).catch(() => null)
  if (!a) return { ...base, route: 'migrating', dammPool: null, swap: null, raw: {} }
  const pair = [a.tokenAMint.toBase58(), a.tokenBMint.toBase58()].sort().join()
  if (pair !== [baseMint, quoteMint].sort().join())
    throw new Error(`the migrated pool ${dammPool} does not pair ${baseMint} with ${quoteMint}`)
  return {
    ...base,
    route: 'damm_v2',
    dammPool,
    swap: {
      route: 'damm_v2',
      pool: dammPool,
      tokenAMint: a.tokenAMint.toBase58(),
      tokenBMint: a.tokenBMint.toBase58(),
      tokenAVault: a.tokenAVault.toBase58(),
      tokenBVault: a.tokenBVault.toBase58(),
      baseMint,
      quoteMint,
    },
    raw: { damm: a },
  }
}

/**
 * Why a buy's swap leg failed, from the program's error code. Each cause has its own
 * receipt and its own retry rule (executor.ts skipBuy):
 *   slippage    the price moved past the minimum-out: tried again later in the period
 *   curve_full  the curve completed first (DBC 6013): retried in the period once it trades on DAMM v2
 *   no_room     less room than quoted (DBC 6033, DAMM v2 6023): re-quoted one unit smaller, once
 *   error:<n>   anything else, named by its code: no retry in the period
 * Codes are the programs' own (DBC IDL 0.2.1, DAMM v2 IDL 0.2.5).
 */
export type SkipCause = 'slippage' | 'curve_full' | 'no_room' | `error:${number}` | 'error:unknown'
export function swapFailure(route: Route, code: number | null): SkipCause {
  if (code === 6002) return 'slippage' // ExceededSlippage, in both programs
  if (route === 'dbc' && code === 6013) return 'curve_full' // PoolIsCompleted
  if (route === 'dbc' && code === 6033) return 'no_room' // InsufficientLiquidity (bonding curve)
  if (route === 'damm_v2' && code === 6023) return 'no_room' // InsufficientLiquidity
  return code === null ? 'error:unknown' : `error:${code}`
}

/** Index of the instruction that failed, from a recorded transaction error (JSON). */
export function failedInstruction(err: string | null): number | null {
  if (!err) return null
  try {
    const e = JSON.parse(err) as { InstructionError?: [number, unknown] }
    return Array.isArray(e.InstructionError) ? Number(e.InstructionError[0]) : null
  } catch {
    return null
  }
}
/** Where the swap sits in a buy: [limit, price, pull, swap]. */
export const SWAP_INDEX = 3
export const PULL_INDEX = 2

/**
 * The "subscription launch" preset, priced in the quote mint (SKR or USDC, 6 decimals).
 * Each choice is for many small, regular buys rather than one rush:
 *  - a flat 1% fee from the first buy: no launch fee scheduler, so a weekly backer pays
 *    the same rate as a day-one buyer and there is no early window to front-run;
 *  - fees collected in the quote token, so the creator's share accrues in SKR or USDC;
 *  - 1 billion supply, 6 decimals, 33% of it kept for the pool after migration, so the last
 *    unit before migration costs 4.12x the first (16x at the common 20%; tools/curve-ratio.ts);
 *  - migration to DAMM v2 at `quoteThreshold` raised, so the weekly buy follows the token;
 *  - the creator gets 50% of trading fees; all LP is permanently locked at migration;
 *  - metadata immutable once created.
 */
/** The share of supply kept for the migrated pool; it sets the curve's price ratio (tools/curve-ratio.ts). */
export const PRESET_MIGRATION_PCT = 33

export function launchPreset(quoteThreshold: number, percentageSupplyOnMigration: number = PRESET_MIGRATION_PCT) {
  return DBC.buildCurve({
    token: {
      tokenType: DBC.TokenType.SPLToken,
      tokenBaseDecimal: DBC.TokenDecimal.SIX,
      tokenQuoteDecimal: 6,
      tokenAuthorityOption: DBC.TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: DBC.BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: DBC.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 50,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: DBC.MigrationOption.MET_DAMM_V2,
      migrationFeeOption: DBC.MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: DBC.ActivationType.Timestamp,
    percentageSupplyOnMigration,
    migrationQuoteThreshold: quoteThreshold,
  })
}

/**
 * The migration crank's compute budget. The SDK's migrateToDammV2 asks for 600,000 units;
 * the priority fee is charged on the limit, so it stays there rather than higher.
 */
export const MIGRATION_BUDGET = { unitLimit: 600_000, microLamportsPerUnit: 10_000 }

/** Where a backed curve stands for the crank. */
export type CurveStage =
  { stage: 'open' } | { stage: 'complete'; dammPool: string } | { stage: 'migrated'; dammPool: string }

/** Whether a curve has filled, and whether it has migrated (to its canonical DAMM v2 pool). */
export async function curveStage(conn: Connection, pool: string): Promise<CurveStage> {
  const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
  const vp = await client.state.getPool(pool)
  if (!vp) throw new Error(`no DBC pool at ${pool}`)
  const ps = (
    vp as unknown as { poolState: { config: PublicKey; baseMint: PublicKey; quoteReserve: BN; isMigrated: number } }
  ).poolState
  const config = await client.state.getPoolConfig(ps.config)
  if (!config) throw new Error(`no DBC config for ${pool}`)
  if (Number(config.migrationOption) !== 1) throw new Error('this curve does not migrate to DAMM v2')
  const dammPool = canonicalDammPool(
    Number(config.migrationFeeOption),
    ps.baseMint.toBase58(),
    config.quoteMint.toBase58(),
  )
  if (Number(ps.isMigrated) === 1) return { stage: 'migrated', dammPool }
  if (ps.quoteReserve.lt(config.migrationQuoteThreshold)) return { stage: 'open' }
  return { stage: 'complete', dammPool }
}

/**
 * The migration of a filled curve to DAMM v2, as the SDK builds it (migrateToDammV2), paid
 * by `payer`. Migration is permissionless. The SDK's own compute-budget instruction is left
 * out (MIGRATION_BUDGET goes first instead); the two position NFT mints are fresh keys that
 * sign with the payer.
 */
export async function migrationInstructions(
  conn: Connection,
  pool: string,
  payer: string,
): Promise<{ instructions: Instruction[]; nftMints: Uint8Array[]; dammPool: string }> {
  const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
  const vp = await client.state.getPool(pool)
  if (!vp) throw new Error(`no DBC pool at ${pool}`)
  const config = await client.state.getPoolConfig(
    (vp as unknown as { poolState: { config: PublicKey } }).poolState.config,
  )
  if (!config) throw new Error(`no DBC config for ${pool}`)
  const dammConfig = DBC.DAMM_V2_MIGRATION_FEE_ADDRESS[Number(config.migrationFeeOption)]
  if (!dammConfig) throw new Error(`unknown migration fee option ${config.migrationFeeOption}`)
  const m = await client.migration.migrateToDammV2({ pool: pk(pool), dammConfig, payer: pk(payer) })
  const ixs = m.transaction.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId))
  const st = (vp as unknown as { poolState: { baseMint: PublicKey } }).poolState
  return {
    instructions: ixs.map(toKit),
    nftMints: [m.firstPositionNftKeypair.secretKey, m.secondPositionNftKeypair.secretKey],
    dammPool: canonicalDammPool(Number(config.migrationFeeOption), st.baseMint.toBase58(), config.quoteMint.toBase58()),
  }
}

/** Metadata URIs above this length push the launch transaction over 1,232 bytes (spike, 1 Oct). */
export const MAX_URI = 100

/**
 * A nuntius partner config: the preset, priced in `quoteMint`, migrating at `quoteThreshold`.
 * Created once per quote mint (tools/launch-config.ts); every launch in that quote is a pool
 * on it. `feeClaimer` takes the partner's share of trading fees and, at migration, the
 * partner's half of the permanently locked LP; `leftoverReceiver` takes any base left over.
 */
export async function configInstructions(
  conn: Connection,
  p: {
    config: string
    feeClaimer: string
    leftoverReceiver: string
    quoteMint: string
    payer: string
    quoteThreshold: number
  },
): Promise<Instruction[]> {
  const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
  const tx = await client.partner.createConfig({
    ...launchPreset(p.quoteThreshold),
    config: pk(p.config),
    feeClaimer: pk(p.feeClaimer),
    leftoverReceiver: pk(p.leftoverReceiver),
    quoteMint: pk(p.quoteMint),
    payer: pk(p.payer),
  })
  return tx.instructions.map(toKit)
}

/**
 * The launch: one pool on nuntius's fixed config for its quote (the fun-launch pattern).
 * The server signs with the fresh base-mint key and hands the rest to the device, which
 * signs once as creator and fee payer.
 */
export async function launchInstructions(
  conn: Connection,
  p: { creator: string; config: string; name: string; symbol: string; uri: string; baseMint: string },
): Promise<Instruction[]> {
  if (p.uri.length > MAX_URI) throw new Error(`metadata URI longer than ${MAX_URI} characters`)
  const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
  const tx = await client.creator.createPool({
    config: pk(p.config),
    baseMint: pk(p.baseMint),
    name: p.name,
    symbol: p.symbol,
    uri: p.uri,
    payer: pk(p.creator),
    poolCreator: pk(p.creator),
  })
  return [...budgetInstructions({ unitLimit: 200_000, microLamportsPerUnit: 50_000 }), ...tx.instructions.map(toKit)]
}

/** The quote mint and fee claimer a config account names (for the launch route's checks). */
export async function readConfig(
  conn: Connection,
  config: string,
): Promise<{ quoteMint: string; feeClaimer: string } | null> {
  const c = await new DBC.DynamicBondingCurveClient(conn, 'confirmed').state.getPoolConfig(config).catch(() => null)
  return c ? { quoteMint: c.quoteMint.toBase58(), feeClaimer: c.feeClaimer.toBase58() } : null
}

// --- The web3.js v1 boundary -------------------------------------------------------------
// The Meteora SDKs are Anchor 0.31 clients: they take a web3.js v1 Connection and PublicKeys.
// This module is the only server file that imports @solana/web3.js; the rest of the server
// holds a MeteoraConnection as an opaque handle and passes addresses as strings.

/** The SDKs' connection, opaque outside this module. */
export type MeteoraConnection = Connection

/** One connection to the RPC for the Meteora SDKs, paged on Helius (pageConnection). */
export function meteoraConnection(rpcUrl: string, doFetch?: Fetch): MeteoraConnection {
  return pageConnection(new Connection(rpcUrl, 'confirmed'), doFetch)
}

/**
 * A connection that answers only getAccountInfo, with an SPL Token-owned 82-byte account:
 * enough for the SDK to compose a launch without any RPC (tests).
 */
export function offlineConnection(): MeteoraConnection {
  return {
    rpcEndpoint: 'offline',
    commitment: 'confirmed',
    getAccountInfo: async () => ({
      owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      data: Buffer.alloc(82),
      lamports: 1,
      executable: false,
    }),
  } as unknown as MeteoraConnection
}

/** The DBC pool a launch creates, from its quote mint, token mint and config key. */
export function dbcPoolAddress(quoteMint: string, baseMint: string, config: string): string {
  return DBC.deriveDbcPoolAddress(new PublicKey(quoteMint), new PublicKey(baseMint), new PublicKey(config)).toBase58()
}

/** A token's decimals and Metaplex symbol; null when the mint account does not exist. */
export async function tokenInfo(
  conn: MeteoraConnection,
  mint: string,
): Promise<{ decimals: number; symbol: string } | null> {
  const m = await conn.getAccountInfo(new PublicKey(mint))
  if (!m || m.data.length < 45) return null
  const decimals = m.data[44] ?? 0
  let symbol = `${mint.slice(0, 4)}…`
  try {
    const md = await conn.getAccountInfo(DBC.deriveMintMetadata(new PublicKey(mint)))
    if (md) {
      // Metaplex metadata: key(1) update_authority(32) mint(32) name(4+len) symbol(4+len)
      const nameLen = md.data.readUInt32LE(65)
      const at = 69 + nameLen
      const symLen = md.data.readUInt32LE(at)
      const s = md.data
        .subarray(at + 4, at + 4 + symLen)
        .toString('utf8')
        .replace(/\0/g, '')
        .trim()
      if (s && /^[\p{L}\p{N}$._-]{1,12}$/u.test(s)) symbol = s
    }
  } catch {
    /* the symbol is cosmetic: keep the short address */
  }
  return { decimals, symbol }
}

/**
 * Helius deprioritizes unpaginated getProgramAccounts (1 Oct): on a Helius URL the
 * Connection's getProgramAccounts is answered by getProgramAccountsV2, paged (see
 * program-accounts.ts), for any Anchor account.all() the SDKs make. readLaunch itself no
 * longer searches: the migrated pool is derived (canonicalDammPool).
 */
export function pageConnection(conn: Connection, doFetch?: Fetch): Connection {
  if (!isHelius(conn.rpcEndpoint)) return conn
  const paged = async (program: PublicKey, config?: { filters?: unknown }) =>
    (await programAccountsV2(conn.rpcEndpoint, program.toBase58(), config?.filters, doFetch)).map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      account: {
        data: Buffer.from(a.account.data[0], 'base64'),
        executable: a.account.executable,
        lamports: a.account.lamports,
        owner: new PublicKey(a.account.owner),
        rentEpoch: a.account.rentEpoch,
      },
    }))
  ;(conn as unknown as { getProgramAccounts: typeof paged }).getProgramAccounts = paged
  return conn
}
