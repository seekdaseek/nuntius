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

### What happened to the proof curve, and the migration

Twelve minutes after the proof pool was created, trading bots routed through its curve (signer `FB1tpBTz…`, through the FLASHX router and Jupiter, in v1 transactions) and filled all 100 SKR by 04:29 UTC on 6 Oct: aggregators index new DBC pools at once, so a tiny curve is swept before any backer arrives. Meteora's keepers do not migrate a curve that small, and nuntius's crank runs only for backed pools, so the executor migrated it with the crank's own code (`server/src/tools/crank.ts`, which calls `Executor.crank`):

| What                                                                           | Address                                                       | Transaction                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Migration to DAMM v2, paid by the executor (23,744,600 lamports, as simulated) | canonical pool `CUgjnSTFC2CoCHesWm8hYAb6sE7mUAdoUhYFuH3w6vCh` | [`2gEqP5Af…`](https://explorer.solana.com/tx/2gEqP5AfyHjqy16NZYvfkCNDTrbYUU1x1mHUzD7KkGutQuXxzJA8UHutbJTJmdxxAhm2yHgNsEHiryymaK9D8XNx) |

The mainnet proof therefore backs the migrated pool: natX's permission buys on DAMM v2. Buys on a curve, the curve completing and the backing following the token through migration are proven on Meteora's deployed programs on localnet (`npm run test:meteora`); on mainnet they come from real launches.

### The proof run on mainnet, 6 Oct

natX backed the migrated proof pool from the Seeker (v1.1.0, Seed Vault): 50 SKR every hour for 7 days. One buy landed on DAMM v2, natX revoked on the Seeker, and the next pull was sent anyway: the Subscriptions program refused it, because the delegation no longer exists. Every transaction below was read back from mainnet; the record is `evidence/proof-run.json`.

| Step (UTC)                                      | Signed by     | Transaction                                                                                                                            | What the chain shows                                                                       |
| ----------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 06:22:35 grant: 50 SKR an hour, 7 days          | natX (Seeker) | [`RZb3AT53…`](https://explorer.solana.com/tx/RZb3AT53P7i6GKvQNR4BDN3eeSYPUCpGTnRDU9PRoK3zmeBipg2uXUS5Xsu6a5GyEwnAXBVzudD3jscWcs5T5tN)  | delegation `GFkN9JnnTJvXKedzUAZng5D7wRNJqHnjc8uVkXD1PZdZ` to the executor                  |
| 06:27:42 the buy, one transaction               | the executor  | [`AiFrumeV…`](https://explorer.solana.com/tx/AiFrumeV4r81DmnsjRRrAsMy3cJKGkc15pYmMRvgAc3ibDQcS1wvY5FidL3y6LP66RyD1Ao2ugN3TXx1npzHsUk)  | natX SKR 156 → 106; natX PROOF 0 → 109,191,776.503476; the executor's SKR 0 → 0; 27,102 CU |
| 06:29:07 revoke                                 | natX (Seeker) | [`2VxWUMjd…`](https://explorer.solana.com/tx/2VxWUMjd5Q6oiky6roRK8X6a5X8oVT3papuWEhycficLNBKaovmE6kAmhLUByDfooGq7tqFGWaFKMcmr9Lp6Bz5b) | the delegation account is closed                                                           |
| 06:29:44 the next pull, sent with preflight off | the executor  | [`GarcPW1D…`](https://explorer.solana.com/tx/GarcPW1DtMLRCcvC6CyevphBn21MXdRrqqbQ7QgRkC91e6yk6nnoVsn6U9jN4nSkydRQnhppNhxSj9GRQVq4v9G)  | failed: `InvalidAccountOwner` in the Subscriptions program; natX SKR stays 106             |

The refused pull is built and sent by `tools/mac/dead-pull.mjs` in the private ops repository; the executor itself never sends it, because the server marks the permission revoked and stops.

## nimus, the first launch on the SKR config

On 6 Oct the treasury wallet (cj7) launched nimus from the Seeker with v1.1.0's Launch screen, then backed it at 25 SKR a week. Before the launch was signed, the server's record was read back: name `nimus`, symbol `NIMUS`, quote SKR on config `DdiaEHah…`, creator cj7, the image link and the description; the metadata URI served the same JSON. Every transaction below was read back from mainnet; the record is `evidence/nimus-launch.json`.

| Step (UTC)                                              | Signed by    | Transaction                                                                                                                            | What the chain shows                                                                                                |
| ------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 06:34:39 launch: pool `BpYoKpXw…dPPU`, token `jYCJ…4B2` | cj7 (Seeker) | [`36HcKcHp…`](https://explorer.solana.com/tx/36HcKcHpAtWxPRCMAjpdsuWPyBwyvHWVn3FpnjNKXwbWC3nUcjShiQb4XM8RvDekZSnQh5rb5wBAqLirVVnFUpn1) | cj7 paid 20,601,640 lamports, as simulated; metadata `nimus` / `NIMUS` / `…/m/jYCJ…4B2.json`, update authority none |
| 06:37:18 backing grant: 25 SKR a week, 90 days          | cj7 (Seeker) | [`ARNrFTDK…`](https://explorer.solana.com/tx/ARNrFTDK9LJWZvh3jcpatJH5YjHqaXnzgibFG8KozJXEbERK8J8zEbcQ7QgkCLELjPpHKTkPXpeEdvVvcy2rbnP)  | delegation `4aRwbjE9azxHjbYQwsQZLjN2RxrndKo9QJBAkrTr5ydC` to the executor                                           |
| 06:45:16 the first buy, on the curve                    | the executor | [`383VkA2U…`](https://explorer.solana.com/tx/383VkA2U1MGPb5rkGSv6AWdq1u9HoG6NDZDcdC5d3p5gEiq1MYb6doqWAicDrRyUpz1Y722mDTUD1Ddb8A5X5Fdf) | DBC swap in one transaction: cj7 SKR 80.04 → 55.04, NIMUS 0 → 673,006.728572; the executor's SKR 0 → 0; 35,780 CU   |

A trading bot (fee payer `AN4ZCJ…`) spent 1,344.5 SKR buying NIMUS within 33 seconds of the launch and sold it all back at 06:38 for 1,317.7 SKR. The round trip paid the curve's 1% fee both ways: after the first buy the pool held 10.80 SKR for the partner (nuntius), 10.80 SKR for the creator and 5.40 SKR for Meteora. These are outside trades, not backing; the backing figures in the feed count only buys nuntius executed.

At 06:57:31 the creator, cj7, bought NIMUS itself, outside nuntius: 3 USDC through an aggregator (program `T1TANpTe…`), routed to 168.896645 SKR into the curve, for 4,528,829.380445 NIMUS ([`5bZCHWur…`](https://explorer.solana.com/tx/5bZCHWurb4kGKrH7aXbc4W9iuUfuEjitZKBMBWkU3JF6iUvcCgde2eZWRdGht8SnPPpWzN5rBfYafdJkfkMA2hsQ)). That is the creator's own swap, not backing. The curve's "raised" counts every trade, so 168.9 of the 196.91 SKR the page showed as raised that morning came from this swap; committed demand and buys executed count only the permissions nuntius runs.

At 07:05 cj7 revoked the 25 SKR weekly backing and at 07:17:21 granted 5 SKR every day for 30 days ([`5pTp1qdz…`](https://explorer.solana.com/tx/5pTp1qdzGztmSaKW4xcwarheZj5Ed1ojKpvhA6djJDApn5SQQ3XDf7fCsQKJrpAfi7M57RtRZWVdBa3AgXGKRrkg), delegation `5F5Rs6PTB4VoaBU7KZqNpdKcaJyDhQSuVyzYFwYJwQS1`); its first buy landed at 07:23:44 ([`4A7QwcTD…`](https://explorer.solana.com/tx/4A7QwcTD4BhNixXvFg5dxkxPsstneot1wLd7DUuts8bcvZuJjvo2N64fTG9q6EtEWpbiVLmERiCGJ8gkPaNaAaaR)), the executor's SKR 0 → 0.

### Backing from a browser: natX in Chrome on the Seeker, through the Mobile Wallet Adapter

On 6 Oct natX backed nimus from the web page (`/l/BpYoKp…`) in Chrome on the Seeker, signing in and approving in Seed Vault through the Mobile Wallet Adapter: 1 SKR every day for 7 days.

| Step (UTC)                              | Signed by           | Transaction                                                                                                                            | What the chain shows                                                                                                                               |
| --------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 09:19:28 grant from the page            | natX (Seed Vault)   | [`5T3iTprP…`](https://explorer.solana.com/tx/5T3iTprPc1BU5AFRsZvWXUwn8Vt5g6rnX8snmPiFBdy7uArxfLm3iYCVB2FYKmy2QR7EPAFNjvqkJD2sZXWYbnNG) | delegation `7bNdu2v4ffEoM3ngF6wYY4rSyJVv9L82t35tFsmhqdJb`; natX paid 4,490,280 lamports: the permission's two accounts, its NIMUS account, the fee |
| 09:24:14 the first buy, never sent      | —                   | `58dVZ1c4…`                                                                                                                            | not on chain: its simulation came back `BlockhashNotFound` from a lagging RPC node and the executor recorded the period refused                    |
| 09:53:04 the same period's buy, rebuilt | the executor (only) | [`4wX2SLR8…`](https://explorer.solana.com/tx/4wX2SLR8jDAcgbxjwfHc389BzpZSYsw9yeXXzL4mu9xLAm8GaZJxRdeGjXPscbePMsBf53mZwMaQeR4brfpmvo1c) | DBC swap in one transaction: natX SKR 106 → 105, NIMUS 0 → 26,716.209842; the executor's SKR 0 → 0; 40,292 CU                                      |

The 09:24 refusal was our bug: a simulation error that is not the program's answer is a transport error, fixed in `a3fdaf3`. With Sergiu's approval, that one ledger row was put back in flight (after a database backup), and the executor rebuilt and landed the buy for the same period. natX is in the operator's own wallets, so the page and the feed tag the buy as the builder's own.
