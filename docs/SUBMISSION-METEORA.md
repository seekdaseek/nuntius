# Submission text: Meteora, Best use of DBC

Draft for the Earn form. The review chat pastes it on Sergiu's "yes meteora"; the same numbers feed the Colosseum fields. Each field's text is the paragraph under its heading, pasted as is: plain sentences, no markdown, parentheses, underscores or em dashes. Re-read every number from its source on the day it is pasted; the sources are listed at the end.

## Project Name

nuntius

## Project Description

Meteora's Dynamic Bonding Curve completes more than 3,000 curves a day, and Litmus counts 909,994 of its 920,078 graduations since April 2025 as uncontested, filled by the creator, the launchpad or one bundle instead of by buyers. nuntius adds the demand that is missing: a backer approves one capped recurring permission in Seed Vault, for example 25 SKR a week for 90 days, and every period one transaction pulls that amount through the Solana Subscriptions program and buys the launch token on its curve, straight into the backer's own wallet. The chain caps what can be taken, the executor holds nothing before or after a buy, a buy that would slip more than 2% is skipped with nothing taken, and one approval revokes the permission. When the curve fills, the buy follows the token to its canonical DAMM v2 pool, and if no keeper migrates the curve, nuntius migrates it. Builders launch on nuntius's fixed DBC configs from the Seeker with one signature, priced in SKR or USDC, with a flat 1% fee, a third of the supply kept for the migrated pool, liquidity locked for good and on-chain metadata that can never change. Every launch has a public page that shows what is raised, the committed weekly demand and what the token's own mint and metadata accounts promise, read from the chain on every load, and anyone can back it from a browser wallet. It is live on mainnet: nimus launched from a Seeker on 6 October and its first backed buy landed on the curve eight minutes after the grant, and a proof pool ran a grant, a buy after migration, a revoke and a pull the chain refused.

## Anything Else

The code is open at github.com/seekdaseek/nuntius, with every mainnet signature in docs/meteora/CONFIGS.md and our notes for Meteora's engineers in FEEDBACK.md. We opened a pull request to the DBC SDK, MeteoraAg/dynamic-bonding-curve-sdk number 121, adding an optional receiver to swap and swap2, the gap that made us build our swap instruction by hand. The whole lifecycle, from launch to migration and the buy that follows it, runs in one command on a local validator against DBC and DAMM v2 cloned from mainnet. Version 1.1.0 is a pre-release APK for the Seeker, and the backing page works in any browser. Two things we report against ourselves: our proof pool would count as uncontested in Litmus's terms, and so far the only backer of nimus is its creator.

## Sources, read on 6 October 2026

- Litmus: github.com/omreor/litmus README, "More than 3,000 DBC bonding curves complete every day" and "since April 2025, 909,994 of 920,078 graduations (98.9%) were uncontested", as of 29 Sep.
- nimus launch `36HcKcHp…` at 06:34:39 UTC; the grant `ARNrFTDK…` at 06:37:18; the first buy `383VkA2U…` at 06:45:16 (docs/meteora/CONFIGS.md).
- The proof run: `RZb3AT53…`, `AiFrumeV…`, `2VxWUMjd…`, `GarcPW1D…` (docs/meteora/CONFIGS.md).
- Preset: flat 1% fee, 33% kept for migration, LP permanently locked half and half, on-chain metadata immutable (`server/src/meteora.ts`, `launchPreset`; read back on mainnet in docs/meteora/CONFIGS.md).
- The PR: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/121.
- nimus's backers: `GET https://nuntius.ochinimus.app/api/launches`, `backers.thirdParty`. Rewrite the last sentence if it is no longer zero.
