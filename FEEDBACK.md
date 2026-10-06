# Feedback for Meteora

From building subscription launches on DBC and DAMM v2 (nuntius, October 2026). Each point names the version we read and how we checked it.

## 1. Neither SDK can pay from one wallet and deliver to another

Both programs accept an output token account owned by someone other than the signer. nuntius depends on it: each period one transaction pulls the backer's capped amount through the Solana Subscriptions program and swaps it, and the swap's output lands in the backer's own account while nuntius's executor signs and holds nothing. On mainnet, 6 Oct 2026:

- DBC: [`383VkA2U…`](https://explorer.solana.com/tx/383VkA2U1MGPb5rkGSv6AWdq1u9HoG6NDZDcdC5d3p5gEiq1MYb6doqWAicDrRyUpz1Y722mDTUD1Ddb8A5X5Fdf), 25 SKR into 673,006.7 NIMUS in the backer's wallet; the executor's SKR 0 → 0.
- DAMM v2: [`AiFrumeV…`](https://explorer.solana.com/tx/AiFrumeV4r81DmnsjRRrAsMy3cJKGkc15pYmMRvgAc3ibDQcS1wvY5FidL3y6LP66RyD1Ao2ugN3TXx1npzHsUk), 50 SKR into PROOF in the backer's wallet; the executor's SKR 0 → 0.

The SDKs cannot build either:

- `@meteora-ag/dynamic-bonding-curve-sdk` (main at `a28b723`, 1.5.13): `swap`, `swap2` and `swap2WithTransferHook` derive both token accounts for `owner` and pass `payer: owner` (`src/services/pool.ts`). The first-buy builders already take a `receiver`; the swaps do not.
- `@meteora-ag/cp-amm-sdk` 1.5.1: `swap2` has a `receiver`, but it moves the input account, the output account and the signer together (`dist/index.js` lines 13848–13849 set both token owners to the receiver, line 13905 makes it the swap's payer). It is "swap on behalf of someone", not "deliver to someone".

So nuntius builds both swap instructions by hand (`server/src/meteora.ts`).

**Our PR:** [MeteoraAg/dynamic-bonding-curve-sdk#121](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/121) adds an optional `receiver` to `swap`, `swap2` and `swap2WithTransferHook`. Without it the built transaction is the same as before. Four tests on the repository's validator; they fail on `main`, and the full suite passes (142 tests). The same change would make sense in cp-amm: an optional output owner that leaves the input and the signer alone.

## 2. The keeper table's "matches" is ambiguous

The DBC developer guide's keeper table lists USDC at "750 USDC" when the threshold "matches". We could not tell whether "matches" means equal to 750, at least 750, or the curve's quote in USD terms, so we set our USDC config to exactly 750 and still run our own crank. Our SKR config (50,000 SKR) is not in the table at all.

What happened when no keeper came: our 100 SKR proof curve was filled by aggregator routing twelve minutes after creation and then sat completed until our executor migrated it ([`2gEqP5Af…`](https://explorer.solana.com/tx/2gEqP5AfyHjqy16NZYvfkCNDTrbYUU1x1mHUzD7KkGutQuXxzJA8UHutbJTJmdxxAhm2yHgNsEHiryymaK9D8XNx), 23,744,600 lamports, as simulated). One sentence in the guide would have told us to plan for that: "a completed curve no keeper picks up stays completed until anyone calls `migration_damm_v2`".

## 3. DBC emits no event for the migration itself

The DBC IDL in SDK 1.5.13 has `EvtCurveComplete`, but nothing for `migration_damm_v2`. To learn that a pool migrated, nuntius polls `isMigrated` and derives the canonical DAMM v2 pool from the base and quote mints and the migration fee option's config. An `EvtMigrateDammV2 { pool, dammPool }` would let indexers, and the apps that follow a token across, stop polling. A helper returning the canonical DAMM v2 pool for a DBC pool would remove the derivation from every client.

## 4. web3.js v1 under the SDKs

The rest of the nuntius server is `@solana/kit`; the Meteora SDKs are the only reason it carries `@solana/web3.js` 1.99 and Anchor 0.31, so we keep both inside one module. On 6 Oct, `npm audit --omit=dev` reports no advisory from that tree; the cost is weight and two type systems. Related: aggregators route through new curves in v1 transactions, which web3.js v1's `getTransaction` cannot decode, so reading those trades needed raw RPC.

## 5. Smaller things we hit

- **Mint authority:** `createConfig` refuses `CreatorUpdateAndMintAuthority` and `PartnerUpdateAndMintAuthority` unless the config is a transfer-hook config. That means an SPL DBC launch never keeps a mint authority, which is a property worth stating in the docs: nuntius's backing page reads it from the chain and shows it.
- **Two names for one setting:** `buildCurve` takes `token.tokenAuthorityOption`, and the config it returns calls it `tokenUpdateAuthority`. Overriding the first name on a built config is silently ignored; a test of ours did exactly that.
- **`enableFirstSwapWithMinFee`:** the SDK adds the instructions sysvar to every swap on such a config. Only a first swap bundled with pool creation needs it; a later swap without it lands (measured on the deployed program, `server/src/meteora-firstswap.localnet.test.ts`).
- **Localnet migration:** cloning DBC and DAMM v2 is not enough. Migration also needs DBC's pool authority account (`FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`) cloned, or it fails with "insufficient lamports 0, need 2770080". `scripts/localnet.sh --meteora` clones it.
- **The race at the end of a curve:** a buy sent as the curve fills fails with 6013 (`PoolIsCompleted`). nuntius waits for the canonical DAMM v2 pool and buys there in the same period. Nothing is pulled from the backer when the buy fails, because the pull and the swap are one transaction.
