/**
 * Reads a nuntius partner config back from the chain and checks every field the program
 * stored against what launchPreset says it should be, plus the transaction that created it.
 *
 *   cd server && npm run build && RPC=<mainnet rpc> node dist/tools/verify-config.js <config> SKR|USDC [signature]
 *
 * Prints one line per field (ok or MISMATCH) and exits non-zero on any mismatch.
 */
import { Connection, PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import { launchPreset, PRESET_MIGRATION_PCT } from '../meteora.js'

const TREASURY = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7'
const EXECUTOR = '23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP'
const QUOTES: Record<string, { mint: string; threshold: number }> = {
  SKR: { mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3', threshold: 50_000 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', threshold: 750 },
}

const [config, symbol, signature] = process.argv.slice(2)
const q = QUOTES[symbol ?? '']
if (!config || !q) {
  console.error('usage: verify-config.js <config> SKR|USDC [signature]')
  process.exit(2)
}
const rpcUrl = process.env.RPC ?? ''
if (!rpcUrl.startsWith('https://')) throw new Error('RPC must be an https mainnet RPC URL (never printed)')
const conn = new Connection(rpcUrl, 'confirmed')

const s = (v: unknown) =>
  BN.isBN(v) ? (v as BN).toString() : v instanceof PublicKey ? v.toBase58() : JSON.stringify(v)
let bad = 0
const check = (field: string, got: unknown, want: unknown) => {
  const ok = s(got) === s(want)
  if (!ok) bad++
  console.log(`${ok ? 'ok      ' : 'MISMATCH'} ${field}: ${s(got)}${ok ? '' : ` (want ${s(want)})`}`)
}

const acc = await conn.getAccountInfo(new PublicKey(config))
check('owner program', acc?.owner, DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID)
const c = await new DBC.DynamicBondingCurveClient(conn, 'confirmed').state.getPoolConfig(config)
if (!c) throw new Error(`no DBC config at ${config}`)
const p = launchPreset(q.threshold)
check('quoteMint', c.quoteMint, new PublicKey(q.mint))
check('feeClaimer', c.feeClaimer, new PublicKey(TREASURY))
check('leftoverReceiver', c.leftoverReceiver, new PublicKey(TREASURY))
for (const k of ['cliffFeeNumerator', 'firstFactor', 'secondFactor', 'thirdFactor', 'baseFeeMode'] as const)
  check(`poolFees.baseFee.${k}`, c.poolFees.baseFee[k], p.poolFees.baseFee[k])
check('dynamic fee off', c.poolFees.dynamicFee.initialized, 0)
for (const k of [
  'collectFeeMode',
  'migrationOption',
  'activationType',
  'tokenType',
  'migrationFeeOption',
  'creatorTradingFeePercentage',
  'tokenUpdateAuthority',
  'partnerLiquidityPercentage',
  'creatorLiquidityPercentage',
  'partnerPermanentLockedLiquidityPercentage',
  'creatorPermanentLockedLiquidityPercentage',
  'migrationQuoteThreshold',
  'sqrtStartPrice',
  'poolCreationFee',
] as const)
  check(k, (c as Record<string, unknown>)[k], (p as Record<string, unknown>)[k])
// Stored as a u8; the preset says false.
check('enableFirstSwapWithMinFee', Number(c.enableFirstSwapWithMinFee), Number(p.enableFirstSwapWithMinFee))
check('tokenDecimal', c.tokenDecimal, p.tokenDecimal)
check('quoteTokenFlag (SPL Token)', c.quoteTokenFlag, 0)
check('migrationFeePercentage', c.migrationFeePercentage, p.migrationFee.feePercentage)
check('creatorMigrationFeePercentage', c.creatorMigrationFeePercentage, p.migrationFee.creatorFeePercentage)
check(
  'migrationSqrtPrice',
  c.migrationSqrtPrice,
  DBC.getMigrationThresholdPrice(p.migrationQuoteThreshold, p.sqrtStartPrice, p.curve),
)
p.curve.forEach((seg, i) => {
  check(`curve[${i}].sqrtPrice`, c.curve[i]!.sqrtPrice, seg.sqrtPrice)
  check(`curve[${i}].liquidity`, c.curve[i]!.liquidity, seg.liquidity)
})
check(
  `curve[${p.curve.length}..19] empty`,
  c.curve.slice(p.curve.length).every((x) => x.sqrtPrice.isZero() && x.liquidity.isZero()),
  true,
)
check('lockedVesting.amountPerPeriod', c.lockedVestingConfig.amountPerPeriod, new BN(0))
check('lockedVesting.cliffUnlockAmount', c.lockedVestingConfig.cliffUnlockAmount, new BN(0))
const curveToFirst = Number(p.curve[0]!.sqrtPrice.toString()) / Number(p.sqrtStartPrice.toString())
console.log(
  `         price ratio, last unit over first: ${(curveToFirst ** 2).toFixed(4)} (kept for migration ${PRESET_MIGRATION_PCT}%)`,
)

if (signature) {
  const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' })
  if (!tx) throw new Error(`no finalized transaction ${signature}`)
  const keys = tx.transaction.message.staticAccountKeys.map((k) => k.toBase58())
  const signers = keys.slice(0, tx.transaction.message.header.numRequiredSignatures)
  check('tx err', tx.meta?.err ?? null, null)
  check('tx signers', signers, [EXECUTOR, config])
  console.log(`         tx fee ${tx.meta?.fee} lamports, compute ${tx.meta?.computeUnitsConsumed}, slot ${tx.slot}`)
  const pre = tx.meta!.preBalances[0]!
  const post = tx.meta!.postBalances[0]!
  console.log(`         executor paid ${pre - post} lamports (rent and fee)`)
}
console.log(bad ? `${bad} MISMATCH(ES)` : 'all fields match')
process.exit(bad ? 1 : 0)
