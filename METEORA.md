# nuntius on Meteora: subscription launches

**Backers commit in advance to buy a token every week, capped and revocable, and the buys run on Meteora's Dynamic Bonding Curve, then DAMM v2.** Each buy is one transaction: a capped pull through the Solana Subscriptions program and a DBC swap that writes the tokens straight into the backer's own account. The backer approves once in Seed Vault; after that, nobody signs but nuntius's executor, and the chain caps what it can take.

_Status, 6 Oct 2026._ nuntius's two partner configs are on mainnet, created with Meteora's Invent CLI (below). A proof pool is live and waiting for its first backer. Traction numbers will be added here dated, from the live feed, once real backers exist; nothing simulated, self-paid or from the proof pool will ever be counted in them.

## Why DBC

DBC's swap writes to any token account, so the backer's capped pull and the buy fit in one transaction with no escrow. Its config lets us set a flat fee and a curve shaped for recurring buyers. Graduation lands in DAMM v2 with locked LP, and the same weekly buy carries on there.

## On mainnet

| What                                                                    | Address                                                                                                  | Proof                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nuntius partner config, SKR (threshold 50,000 SKR)                      | `DdiaEHahNnz41GHh2AHCsZqGuuoW1A1nnjDKFN8bYM3d`                                                           | [created with Invent](https://explorer.solana.com/tx/522NQYSaCWGkC9VwQqzRarjRZi7u5CQnZiwKMLp5jwiMeCTJvc3YeJ9FVKPmE74qD9zE7Lpx2onCCByCqvgvLBfa), every field read back ([docs/meteora/CONFIGS.md](docs/meteora/CONFIGS.md)) |
| nuntius partner config, USDC (threshold 750 USDC)                       | `HyT5SubGeApBbRce3KQdkaPJv8K4yFHSg7bLrtu15eSk`                                                           | [created with Invent](https://explorer.solana.com/tx/Y6M3uufDHVWw8rg2eit1RmaoLcAdfUowPvKAznftKSf5EpiZJaKjmgH5WpuBcuwgh9fTAn3UKXiqpcpiFEg9oD4)                                                                              |
| Proof pool, PROOF, not for trading (threshold 100 SKR)                  | `5qeAeoorEHpwecPkehAVedeYaWhMVpJaFMD52A8oAtHX`                                                           | [created by the executor](https://explorer.solana.com/tx/4sa7jfqEEGXmm6PQsbC4ghQ53RKQ42MoFEbHh28wo7zgBzD4J8gCKaAsXVQB8qo4EUQZgV1aft5btb2Fr5KAY1yj)                                                                         |
| Proof run: grant, one DAMM v2 buy, revoke, the next pull refused        | natX → the executor                                                                                      | [four transactions, 6 Oct](docs/meteora/CONFIGS.md#the-proof-run-on-mainnet-6-oct)                                                                                                                                         |
| nimus (NIMUS), the first launch on the SKR config, signed on the Seeker | pool `BpYoKpXwvM4gvD1VxenZAZ9vzV9QWdqZWKXm8DW3dPPU`, token `jYCJQbTyVKCCpuGyGP4uqoy1cF8bCtCarnWsU5xQ4B2` | [launch, backing and the first curve buy](docs/meteora/CONFIGS.md#nimus-the-first-launch-on-the-skr-config)                                                                                                                |

Read any launch, live: `curl -s https://nuntius.ochinimus.app/api/launch/5qeAeoorEHpwecPkehAVedeYaWhMVpJaFMD52A8oAtHX`

## The subscription curve

Every launch on nuntius is a pool on one of the two configs above (the fun-launch pattern: one partner config per quote token, `createPool` per launch). The preset (`launchPreset`, `server/src/meteora.ts`):

| Choice                                     | Value                                                    | Why                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Share of supply kept for the migrated pool | 33%                                                      | The last token before migration costs **4.12x** the first. At the common 20% it is 16x. A backer who joins late pays at most about four times what the first backer paid. |
| Fee                                        | flat 1% from the first buy, collected in the quote token | A weekly backer pays what a day-one buyer pays; no early window to front-run                                                                                              |
| Fee split on the curve                     | 0.4% nuntius (partner), 0.4% creator, 0.2% protocol      | `creatorTradingFeePercentage` 50                                                                                                                                          |
| Migration                                  | DAMM v2, fixed 1% pool fee (option 2)                    |                                                                                                                                                                           |
| LP after migration                         | permanently locked, half partner, half creator           | Liquidity cannot be pulled                                                                                                                                                |
| Supply, decimals, metadata                 | 1 billion, 6, immutable                                  |                                                                                                                                                                           |

The ratio is measured, not asserted: `server/src/tools/curve-ratio.ts` builds the real config parameters and measures the price of the first and the last unit two ways (the curve's sqrt prices and the SDK's own swap quotes), output in `evidence/curve-ratio.json`:

| Kept for migration     | 20%    | 25%   | 30%   | 31%   | **33%**   | 35%   | 40%   |
| ---------------------- | ------ | ----- | ----- | ----- | --------- | ----- | ----- |
| Last unit / first unit | 16.00x | 9.00x | 5.44x | 4.95x | **4.12x** | 3.45x | 2.25x |

The trade-off, plainly: a smaller edge for the earliest backers, more tokens in the migrated pool, and a lower fully diluted value at graduation.

**What nuntius earns** (said on the launch screen before Seed Vault opens): 0.4% of curve trades and half of the locked pool's fees after graduation. The fee claimer of both configs is nuntius's treasury `4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7`.

## Tested on Meteora's programs as deployed

`npm --prefix server run test:meteora` clones DBC, DAMM v2 and Metaplex Token Metadata from mainnet into a local validator (nothing of Meteora's source is fetched or built) and runs the whole lifecycle with the server's own code: three backers, buys over several periods, a trader pushing the curve to its end, the last buy cut to the room left, the race at completion, a decoy DAMM v2 pool, the migration crank, the buys that follow on DAMM v2, and a revoke. Every buy asserts that the executor holds the same quote and launch-token balances after it as before. The run writes `evidence/meteora-localnet-results.json`.

## What we do not use, and why

- **DLMM.** "Conviction Pools" appears in Meteora's listing as an example idea. Recurring capped buying needs a curve that sells and a pool that follows it, which DBC and DAMM v2 are; DLMM is out of our scope.
- **Compounding DAMM v2** (migration fee option 6, compounding collect mode). It reinvests part of the locked LP's fees into the pool, which would break the line we disclose to every launcher and backer: nuntius earns half of the locked pool's fees after graduation. And it could not be proven on mainnet with our small proof config before a real launch used it. We keep the fixed 1% option.
- **Partner metadata** on the configs. Creating it needs a signature from the treasury's Seed Vault for a transaction type the app does not otherwise build; the configs are identified here instead.
