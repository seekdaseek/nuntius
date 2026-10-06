# nuntius partner configs on mainnet

Created 6 Oct 2026 with Meteora Invent (`pnpm studio dbc-create-config`, meteora-invent `dd77ef3`, DBC SDK 1.5.11) from the files in this folder, paid by the executor `23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP`. Invent's `buildCurve` (SDK 1.5.11) and nuntius's `launchPreset` (SDK 1.5.13) were compared field by field before sending: 28 of 28 equal for both, with a positive control (20% instead of 33% differs in `sqrtStartPrice` and `curve`).

| Quote | Config                                         | Transaction                                                                                                                            |
| ----- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| SKR   | `DdiaEHahNnz41GHh2AHCsZqGuuoW1A1nnjDKFN8bYM3d` | [`522NQYSa…`](https://explorer.solana.com/tx/522NQYSaCWGkC9VwQqzRarjRZi7u5CQnZiwKMLp5jwiMeCTJvc3YeJ9FVKPmE74qD9zE7Lpx2onCCByCqvgvLBfa) |
| USDC  | `HyT5SubGeApBbRce3KQdkaPJv8K4yFHSg7bLrtu15eSk` | [`Y6M3uufD…`](https://explorer.solana.com/tx/Y6M3uufDHVWw8rg2eit1RmaoLcAdfUowPvKAznftKSf5EpiZJaKjmgH5WpuBcuwgh9fTAn3UKXiqpcpiFEg9oD4)  |

Each was read back from the chain with `server/src/tools/verify-config.ts`, which checks every stored field against `launchPreset`:

## SKR

```
ok       owner program: dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
ok       quoteMint: SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3
ok       feeClaimer: 4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7
ok       leftoverReceiver: 4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7
ok       poolFees.baseFee.cliffFeeNumerator: 10000000
ok       poolFees.baseFee.firstFactor: 0
ok       poolFees.baseFee.secondFactor: 0
ok       poolFees.baseFee.thirdFactor: 0
ok       poolFees.baseFee.baseFeeMode: 0
ok       dynamic fee off: 0
ok       collectFeeMode: 0
ok       migrationOption: 1
ok       activationType: 1
ok       tokenType: 0
ok       migrationFeeOption: 2
ok       creatorTradingFeePercentage: 50
ok       tokenUpdateAuthority: 1
ok       partnerLiquidityPercentage: 0
ok       creatorLiquidityPercentage: 0
ok       partnerPermanentLockedLiquidityPercentage: 50
ok       creatorPermanentLockedLiquidityPercentage: 50
ok       migrationQuoteThreshold: 50000000000
ok       sqrtStartPrice: 111837359347469748
ok       poolCreationFee: 0
ok       enableFirstSwapWithMinFee: 0
ok       tokenDecimal: 6
ok       quoteTokenFlag (SPL Token): 0
ok       migrationFeePercentage: 0
ok       creatorMigrationFeePercentage: 0
ok       migrationSqrtPrice: 227063723174707881
ok       curve[0].sqrtPrice: 227063723174707881
ok       curve[0].liquidity: 147658207557053790125659542404058
ok       curve[1].sqrtPrice: 79226673521066979257578248091
ok       curve[1].liquidity: 2877246369574314569169714
ok       curve[2..19] empty: true
ok       lockedVesting.amountPerPeriod: 0
ok       lockedVesting.cliffUnlockAmount: 0
         price ratio, last unit over first: 4.1221 (kept for migration 33%)
ok       tx err: null
ok       tx signers: ["23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP","DdiaEHahNnz41GHh2AHCsZqGuuoW1A1nnjDKFN8bYM3d"]
         tx fee 20150 lamports, compute 36941, slot 453789084
         executor paid 5994230 lamports (rent and fee)
all fields match
```

## USDC

```
ok       owner program: dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
ok       quoteMint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
ok       feeClaimer: 4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7
ok       leftoverReceiver: 4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7
ok       poolFees.baseFee.cliffFeeNumerator: 10000000
ok       poolFees.baseFee.firstFactor: 0
ok       poolFees.baseFee.secondFactor: 0
ok       poolFees.baseFee.thirdFactor: 0
ok       poolFees.baseFee.baseFeeMode: 0
ok       dynamic fee off: 0
ok       collectFeeMode: 0
ok       migrationOption: 1
ok       activationType: 1
ok       tokenType: 0
ok       migrationFeeOption: 2
ok       creatorTradingFeePercentage: 50
ok       tokenUpdateAuthority: 1
ok       partnerLiquidityPercentage: 0
ok       creatorLiquidityPercentage: 0
ok       partnerPermanentLockedLiquidityPercentage: 50
ok       creatorPermanentLockedLiquidityPercentage: 50
ok       migrationQuoteThreshold: 750000000
ok       sqrtStartPrice: 13697225999847938
ok       poolCreationFee: 0
ok       enableFirstSwapWithMinFee: 0
ok       tokenDecimal: 6
ok       quoteTokenFlag (SPL Token): 0
ok       migrationFeePercentage: 0
ok       creatorMigrationFeePercentage: 0
ok       migrationSqrtPrice: 27809513043730298
ok       curve[0].sqrtPrice: 27809513043730298
ok       curve[0].liquidity: 18084366793073238491524839150654
ok       curve[1].sqrtPrice: 79226673521066979257578248091
ok       curve[1].liquidity: 2877675432643873029428285
ok       curve[2..19] empty: true
ok       lockedVesting.amountPerPeriod: 0
ok       lockedVesting.cliffUnlockAmount: 0
         price ratio, last unit over first: 4.1221 (kept for migration 33%)
ok       tx err: null
ok       tx signers: ["23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP","HyT5SubGeApBbRce3KQdkaPJv8K4yFHSg7bLrtu15eSk"]
         tx fee 20150 lamports, compute 36977, slot 453789411
         executor paid 5994230 lamports (rent and fee)
all fields match
```

## The proof config and pool (not for trading)

For the mainnet lifecycle proof, the executor created on 6 Oct, with `server/src/tools/proof-setup.ts` (record: `evidence/proof-setup.json`):

| What                                                                     | Address                                        | Transaction                                                                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Executor USDC account                                                    | `4siQKuMjEYiBHfzvyCWwe5E2PYDYS28qMK3tR1eS17mN` | [`cF1Kx6bC…`](https://explorer.solana.com/tx/cF1Kx6bC2vsVGZtr7eUQ1xJBmVCFG1mYUEFMgV74BqHGLuUhSwFBCJjpUce7NTFH6s21mq1So5eRkzAXxMPauNk)  |
| Executor SKR account                                                     | `HmnL3xhbLDUvS5mA1HqTNghgFvKuYvzRgWaoW3Bjn2p6` | [`38hXArLb…`](https://explorer.solana.com/tx/38hXArLbEAgpekofRwXNYKdYTqB4YgJHY5EFqu79Bw37BUuFzgLyS7oUYjWE6cU4nJqxvwc1S5EYWh5Tso96KYgz) |
| Proof config, 100 SKR threshold                                          | `5eEdfg9bWcTCwz5oHcnSydJWqWSn1FhkU7vHM5c1nCiQ` | [`5zwt8ujf…`](https://explorer.solana.com/tx/5zwt8ujfV9ErSN8vpEaecH4PVdn6E5SFAFJMCSbjBGUp9hRfY7yvuQ3nhA1yCeicLrPaYSYjXETmQF8rvSMVuqd3) |
| Proof pool (token `GJKKCX3vYaYrfYVBbi1Thu3ofo31ussxLjiJPFZ76j5L`, PROOF) | `5qeAeoorEHpwecPkehAVedeYaWhMVpJaFMD52A8oAtHX` | [`4sa7jfqE…`](https://explorer.solana.com/tx/4sa7jfqEEGXmm6PQsbC4ghQ53RKQ42MoFEbHh28wo7zgBzD4J8gCKaAsXVQB8qo4EUQZgV1aft5btb2Fr5KAY1yj) |

The proof config is the same preset at a 100 SKR threshold: `THRESHOLD=100 node dist/tools/verify-config.js 5eEdfg9b… SKR` reports every field matching. A proof is not traction: its graduation will be "uncontested" by any measure, and it is never counted in the headline.
