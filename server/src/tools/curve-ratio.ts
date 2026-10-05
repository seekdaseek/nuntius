/**
 * B1: how much more the last base unit on a subscription-launch curve costs than the first.
 * Measured on the preset's real config parameters (launchPreset, through the SDK's
 * buildCurve) in two independent ways:
 *   1. from the curve itself: (migration sqrt price / start sqrt price)^2;
 *   2. from the SDK's own swap quote: a 0.01-unit buy on a fresh curve, then the same buy
 *      on the curve one 0.01-unit buy short of its migration threshold.
 * The fee is a flat 1% at both ends, so it does not move the ratio.
 *
 *   cd server && npm run build && node dist/tools/curve-ratio.js [threshold] > ../evidence/curve-ratio.json
 */
import BN from 'bn.js'
import { Connection, PublicKey } from '@solana/web3.js'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import { launchPreset, PRESET_MIGRATION_PCT } from '../meteora.js'

const THRESHOLD = Number(process.argv[2] ?? 50_000)
const TINY = new BN(10_000) // 0.01 of a 6-decimal quote token
const QUOTE = new PublicKey('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3')
const program = DBC.createDbcProgram(new Connection('http://127.0.0.1:1'), 'confirmed').program

function zeroed(name: string) {
  const coder = program.coder.accounts
  const acc = program.idl.accounts.find((a) => a.name.toLowerCase() === name.toLowerCase())!
  return coder.decode(name, Buffer.concat([Buffer.from(acc.discriminator), Buffer.alloc(coder.size(name) - 8)]))
}

/** The curve as the program would hold it right after creation, from these config parameters. */
function fresh(params: ReturnType<typeof launchPreset>) {
  const cfg = zeroed('poolConfig')
  const config = {
    ...cfg,
    quoteMint: QUOTE,
    poolFees: { ...cfg.poolFees, baseFee: { ...cfg.poolFees.baseFee, ...params.poolFees.baseFee } },
    collectFeeMode: params.collectFeeMode,
    activationType: params.activationType,
    migrationQuoteThreshold: params.migrationQuoteThreshold,
    // The program computes this when the config is created; the SDK computes it the same way.
    migrationSqrtPrice: DBC.getMigrationThresholdPrice(
      params.migrationQuoteThreshold,
      params.sqrtStartPrice,
      params.curve,
    ),
    sqrtStartPrice: params.sqrtStartPrice,
    curve: [...params.curve, ...Array(20 - params.curve.length).fill({ sqrtPrice: new BN(0), liquidity: new BN(0) })],
  } as unknown as DBC.PoolConfig
  const vp = zeroed('virtualPool')
  const pool = {
    ...vp,
    poolState: {
      ...vp.poolState,
      sqrtPrice: params.sqrtStartPrice,
      quoteReserve: new BN(0),
      baseReserve: new BN('1000000000000000'),
    },
  } as unknown as DBC.VirtualPool
  return { config, pool }
}

const buy = (pool: DBC.VirtualPool, config: DBC.PoolConfig, amount: BN) =>
  DBC.swapQuoteExactIn(pool, config, false, amount, 0, false, new BN(1_800_000_000), false)

function measure(pct: number) {
  const params = launchPreset(THRESHOLD, pct)
  const migrationSqrt = DBC.getMigrationThresholdPrice(
    params.migrationQuoteThreshold,
    params.sqrtStartPrice,
    params.curve,
  )
  const sq = (x: BN) => Number(x.toString()) ** 2
  const fromCurve = sq(migrationSqrt) / sq(params.sqrtStartPrice)

  const { config, pool } = fresh(params)
  const first = buy(pool, config, TINY)
  // Fill the curve to one tiny buy short of its threshold, then buy that last tiny amount.
  const threshold = params.migrationQuoteThreshold
  const toEnd = DBC.swapQuotePartialFill(pool, config, false, threshold.muln(2), 0, false, new BN(1_800_000_000), false)
  const fillIn = toEnd.includedFeeInputAmount.sub(TINY.muln(2))
  const filled = buy(pool, config, fillIn)
  const late = {
    ...pool,
    poolState: {
      ...(pool as unknown as { poolState: object }).poolState,
      sqrtPrice: filled.nextSqrtPrice,
      quoteReserve: fillIn
        .sub(filled.tradingFee)
        .sub(filled.protocolFee)
        .sub(filled.referralFee ?? new BN(0)),
    },
  } as unknown as DBC.VirtualPool
  const last = buy(late, config, TINY)
  const price = (q: { outputAmount: BN }) => TINY.toNumber() / Number(q.outputAmount.toString())
  return {
    percentageSupplyOnMigration: pct,
    soldOnCurvePct: 100 - pct,
    formula: ((100 - pct) / pct) ** 2,
    fromCurveSqrtPrices: fromCurve,
    fromSwapQuotes: price(last) / price(first),
    firstBuy: { quoteIn: TINY.toString(), baseOut: first.outputAmount.toString() },
    lastBuy: { quoteIn: TINY.toString(), baseOut: last.outputAmount.toString() },
  }
}

const rows = [20, 25, 30, 31, 33, 35, 40].map(measure)
process.stdout.write(
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      sdk: '@meteora-ag/dynamic-bonding-curve-sdk 1.5.13 buildCurve',
      presetDefaultPct: PRESET_MIGRATION_PCT,
      thresholdUi: THRESHOLD,
      note: 'ratio = price of the last base unit before migration / price of the first; flat 1% fee at both ends',
      rows,
    },
    null,
    2,
  )}\n`,
)
