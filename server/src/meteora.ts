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
 * Meteora's keepers migrate it, then the DAMM v2 pool it migrated to. Near the end of the
 * curve the buy is cut to what the curve still takes, because an exact-in that would
 * cross the migration threshold fails.
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

export function quoteDamm(
  conn: Connection,
  state: CPAMM.PoolState,
  quoteMint: string,
  amount: bigint,
  slippageBps: number,
  nowS: number,
  slot: number,
): BuyQuote {
  const q = new CPAMM.CpAmm(conn).getQuote2({
    inputTokenMint: pk(quoteMint),
    slippage: 0,
    currentPoint: new BN(Number(state.activationType) === 1 ? nowS : slot),
    poolState: state,
    tokenADecimal: 6,
    tokenBDecimal: 6,
    hasReferral: false,
    swapMode: CPAMM.SwapMode.ExactIn,
    amountIn: new BN(amount.toString()),
  })
  const quotedOut = BigInt(q.outputAmount.toString())
  return { kind: 'buy', amountIn: amount, quotedOut, minimumOut: minimumOut(quotedOut, slippageBps) }
}

/** Reads a launch: curve progress, and which pool a buy goes to now. */
export async function readLaunch(
  conn: Connection,
  pool: string,
  knownDammPool: string | null = null,
): Promise<LaunchState & { raw: { dbc?: { pool: DBC.VirtualPool; config: DBC.PoolConfig }; damm?: CPAMM.PoolState } }> {
  const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
  const vp = await client.state.getPool(pool)
  if (!vp) throw new Error(`no DBC pool at ${pool}`)
  const ps = (
    vp as unknown as {
      poolState: {
        config: PublicKey
        baseMint: PublicKey
        baseVault: PublicKey
        quoteVault: PublicKey
        quoteReserve: BN
        isMigrated: number
      }
    }
  ).poolState
  const config = await client.state.getPoolConfig(ps.config)
  if (!config) throw new Error(`no DBC config for ${pool}`)
  const quoteMint = config.quoteMint.toBase58()
  const baseMint = ps.baseMint.toBase58()
  const threshold = config.migrationQuoteThreshold
  const raised = BN.min(ps.quoteReserve, threshold)
  const progressBps = threshold.isZero() ? 0 : raised.muln(10_000).div(threshold).toNumber()
  const base = {
    pool,
    baseMint,
    quoteMint,
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
  if (Number(ps.isMigrated) !== 1) return { ...base, route: 'migrating', dammPool: null, swap: null, raw: {} }
  // Migrated: the DAMM v2 pool holding this base mint against the same quote mint.
  const cp = new CPAMM.CpAmm(conn)
  let found: { publicKey: PublicKey; account: CPAMM.PoolState } | null = null
  if (knownDammPool) found = { publicKey: pk(knownDammPool), account: await cp.fetchPoolState(pk(knownDammPool)) }
  else {
    const all = [
      ...(await cp.fetchPoolStatesByTokenAMint(ps.baseMint)),
      ...(await cp.fetchPoolStatesByTokenBMint(ps.baseMint)),
    ]
    found =
      all.find((x) => x.account.tokenAMint.toBase58() === quoteMint || x.account.tokenBMint.toBase58() === quoteMint) ??
      null
  }
  if (!found) return { ...base, route: 'migrating', dammPool: null, swap: null, raw: {} }
  const a = found.account
  return {
    ...base,
    route: 'damm_v2',
    dammPool: found.publicKey.toBase58(),
    swap: {
      route: 'damm_v2',
      pool: found.publicKey.toBase58(),
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
 *  - 1 billion supply, 6 decimals, 20% of it kept for the pool after migration;
 *  - migration to DAMM v2 at `quoteThreshold` raised, so the weekly buy follows the token;
 *  - the creator gets 50% of trading fees; all LP is permanently locked at migration;
 *  - metadata immutable once created.
 */
export function launchPreset(quoteThreshold: number) {
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
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: quoteThreshold,
  })
}

/** Metadata URIs above this length push the launch transaction over 1,232 bytes (spike, 1 Oct). */
export const MAX_URI = 100

/**
 * The launch: config + pool in one transaction. The server signs with the fresh config and
 * base-mint keys and hands the rest to the device, which signs once as creator and fee payer.
 */
export async function launchInstructions(
  conn: Connection,
  p: {
    creator: string
    quoteMint: string
    quoteThreshold: number
    name: string
    symbol: string
    uri: string
    config: string
    baseMint: string
  },
): Promise<Instruction[]> {
  if (p.uri.length > MAX_URI) throw new Error(`metadata URI longer than ${MAX_URI} characters`)
  const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
  const tx = await client.partner.createConfigAndPool({
    ...launchPreset(p.quoteThreshold),
    config: pk(p.config),
    feeClaimer: pk(p.creator),
    leftoverReceiver: pk(p.creator),
    quoteMint: pk(p.quoteMint),
    payer: pk(p.creator),
    tokenType: DBC.TokenType.SPLToken,
    preCreatePoolParam: {
      name: p.name,
      symbol: p.symbol,
      uri: p.uri,
      poolCreator: pk(p.creator),
      baseMint: pk(p.baseMint),
    },
  })
  return [...budgetInstructions({ unitLimit: 400_000, microLamportsPerUnit: 50_000 }), ...tx.instructions.map(toKit)]
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
 * program-accounts.ts). Anchor's account.all() calls it for the DAMM v2 pool lookup.
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
