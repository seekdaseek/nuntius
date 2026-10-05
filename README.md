# nuntius — mandatum

**Grant a payment once in Seed Vault. The chain holds the line. Your phone gets a receipt for every pull, including the ones the chain refused.**

`nuntius` is the app. **mandatum** is what it does: a capped, revocable, recurring on-chain payment authority. The user fills in one sentence (_"Rent to Ana can receive up to 25 USDC every week, until 26 Dec 2026"_) and approves it with **one** Seed Vault signature. After that, payments run on schedule while the phone stays in a pocket. Anything above the cap is rejected by the Solana Subscriptions program itself, with custom error `0x190`. Every pull, and every refusal, arrives as a push that opens the on-chain proof. Revoking is also one signature.

nuntius also works as a **permission manager for the whole Subscriptions standard**. It lists every delegation the wallet has granted, whether to nuntius or to any other app. It sends a receipt when _any_ delegatee pulls. It flags permissions that were created outside nuntius, and it revokes any of them with one approval.

Built for the Solana Seeker. Android only: Mobile Wallet Adapter and Seed Vault are the mechanism, not decoration.

|                                    |                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Judges, start here                 | [JUDGE_GUIDE.md](JUDGE_GUIDE.md): install and verify in five minutes                                                                                                                                                                                                                                       |
| v1.0.2 (5 Oct): Type it your way   | Write the permission in your own words and Fill; the SKR builder starter is back: [below](#v102-5-october-2026-type-it-your-way-and-the-skr-builder-starter) and [SECURITY.md §4b](SECURITY.md)                                                                                                            |
| v1.0.1 (4 Oct): security hardening | What changed and how it is proven: [below](#v101-4-october-2026-security-hardening) and [SECURITY.md §7](SECURITY.md)                                                                                                                                                                                      |
| The APK                            | https://github.com/seekdaseek/nuntius/releases/tag/v1.0.2 (`nuntius-1.0.2.apk`), sha256 `fc54b8fc3badd3854e4af62bca45d04dfbc9c44901b50b06cac64da715c26faf`; v1.0.1 stays at https://github.com/seekdaseek/nuntius/releases/tag/v1.0.1, v1.0.0 at https://github.com/seekdaseek/nuntius/releases/tag/v1.0.0 |
| Demo video (1:45)                  | https://youtu.be/rXs5zppcYKs                                                                                                                                                                                                                                                                               |
| Pitch video (1:33)                 | https://youtu.be/Zq1veG63Snw                                                                                                                                                                                                                                                                               |
| Threat model                       | [SECURITY.md](SECURITY.md): what the cap bounds and what it does not                                                                                                                                                                                                                                       |
| Why this, not something else       | [RESEARCH.md](RESEARCH.md)                                                                                                                                                                                                                                                                                 |

---

## v1.0.2 (5 October 2026): Type it your way, and the SKR builder starter

- **Type it your way.** On New permission, write the permission in your own words, for example _"Pay Ana 5 cents a day for a week"_, and tap **Fill**. Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) reads the sentence and proposes the terms. Plain code then checks each one against the server's own rules: the token must be one it offers; the amount must be more than zero and within that token's per-period ceiling; the period must be one of the form's; the end must be after today and at most 90 days ahead. A term that fails stays empty, with a one-line reason. The model never returns an address: anything address-shaped in its answer is dropped. Fill empties the payee, so Approve stays off until an address is pasted by hand. The preview, the "Seed Vault will show" line and the transaction check run exactly as for typed terms. On any failure the app says it could not read the text, and the form works as before. What the model can and cannot do, what is sent to it and where its key lives: [SECURITY.md §4b](SECURITY.md).
- **Back a Seeker builder** is again the 25 SKR a week, 90-day recurring payment it was in v1.0.0, while subscription launches are off. With launches on, it opens the launch flow.
- **A grant the wallet reports as failed is checked on chain.** In the first attempt below, the wallet reported an error after the grant had landed. The app now asks the server whether the grant landed before it says "not granted". The guard activates a pending permission whose delegation it finds live with exactly its terms (`8be7a2c`, `bf1313d`; tests in `server/src/guard.test.ts` and `core/core.test.ts`).
- versionName 1.0.2, versionCode 2.

**On the device: 5 October 2026, v1.0.2 installed over v1.0.1** (`adb install -r`, an update: first install 30 Sep), built from `bf1313d`, server at the same commit, `MANDATE_LAUNCHES` unset. Every wallet tap was the owner's in Seed Vault.

**Attempt 1 (build `36fd0e0`) failed at the first grant, and was fixed.**

- **What worked:** the update kept the sign-in, and Fill read the sentence.
- **The failure:** the grant landed one second after the Seed Vault signature ([`43VQo7Xi…`](https://explorer.solana.com/tx/43VQo7XiPt2s31DLHks8tpcVUZcqp2YgWvTMpd2E3z9WVw3RPSj5gSZ7gUbupZ72GKjnurCkgi7AFZkHxe4BeAb7)). The wallet then held its sheet for 84 s and reported an error, so the app never confirmed the grant. The server then swept the pending permission while its delegation was live, and nothing pulled.
- **The retry:** the app's transaction check refused it before Seed Vault. Seed Vault would have shown 0.70 USDC while the screen said 0.35.
- **Cleanup:** the owner revoked the stray delegation from home ([`3WRM9pqt…`](https://explorer.solana.com/tx/3WRM9pqt71KZ5fT8p7xgTFpWekLhM9DCLmxcqeuWS6wTqUvM2geXFBjb2XnAtKdLxV3fXtGV62zf7wkdGHG8JJfH)).

**Attempt 2 (build `bf1313d`, the release) passed every step:**

| Step                                       | Result                                                                                                                                                                                                                                                                        | Transaction                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Open after the update                      | still signed in as cj7, "✓ Seeker verified", token account delegate none                                                                                                                                                                                                      | —                                                                                                                                      |
| Type it your way                           | "Pay Ana 5 cents a day for a week" → **Fill** → "Filled from your words. Check every term.": Ana, 0.05 USDC, every day, until 12 Oct, 7 days, payee empty, Approve off (about 2 s on the recording); the server logged the text's length (32) and the outcome, never the text | —                                                                                                                                      |
| Grant Ana after pasting natX, 06:59:56 UTC | the line above Approve and Seed Vault both showed 0.35 USDC; one signer, cj7                                                                                                                                                                                                  | [`4vCAEkPz…`](https://explorer.solana.com/tx/4vCAEkPz2Nu76YrcXEPpAMdddsWwvPCKBYTLeLzovqzNgyF9QUVUNAJp3N3G2x7cNVEqX9AACjnnK26XyJrWgv4Y) |
| First pull, 07:00:10 UTC                   | 14 s after the grant; one signer, the delegatee; 0.05 USDC; push "Ana received 0.05 USDC"                                                                                                                                                                                     | [`5qjWpYP7…`](https://explorer.solana.com/tx/5qjWpYP7LzKE1yPUBXWpGkfiP4WeduY76gj6u5zSkYaDjpiH6L88W9FeRPzCxp73FrJfQN8s4ZNUahd7oS6tjMvW) |
| Revoke Ana, 07:01:05 UTC                   | one Seed Vault sheet; one signer, cj7; "Token account delegate: none"                                                                                                                                                                                                         | [`2asfK8uc…`](https://explorer.solana.com/tx/2asfK8uc9LdSPoWUts46U9a7xUrtS2MqdBX2thxweeBFUBnHbQerWgwmnooy3KaiQ463sAv5hCNMN6oV9NAeQSjv) |
| Back a Seeker builder, 07:02:24 UTC        | stays on New permission: Seeker builder, 25 SKR every week until 3 Jan; natX pasted; the line and Seed Vault both showed 325 SKR; one signer, cj7                                                                                                                             | [`5UyuFt8u…`](https://explorer.solana.com/tx/5UyuFt8uTZrHppkA2zxW6Tyf8U9eJ9Yv3mkxYtyv3RpyBnUUW6G73Ad7NWpDhH5YMYXfJoQrrvE9rKKuUTmyxZ9Y) |
| First pull, 07:02:27 UTC                   | 3 s after the grant; one signer, the delegatee; 25 SKR; push "Seeker builder received 25 SKR"; receipt "0 of 25 left this week · Signed by nuntius executor only · You signed nothing"                                                                                        | [`i7bbzYzr…`](https://explorer.solana.com/tx/i7bbzYzrbiVq1DprQBeYyVPUwEzCjxqR3LyZK5pXmbdehKZXrqwmZCwb7FRcfm9bGWCLSRbQ2hqUXu7vfgcaw4H)  |
| Revoke the builder, 07:03:54 UTC           | one signer, cj7; SKR delegate none                                                                                                                                                                                                                                            | [`24CUYKkr…`](https://explorer.solana.com/tx/24CUYKkrksAwQH4FDrwjwi8S5tzFxkW6qjw7RZ6pJADs3i5brhWZoxx2MmDRo4CwVxodQEkxrRPsjTvSxp7gtoKR) |
| Sign out, sign in, widget, push            | sessions 8 → 7 → 8 and push tokens 1 → 0 → 1; the widget draws "Clock in, day 1 · No live permissions"; a test push from the server to the token registered at sign-in arrived (FCM 200)                                                                                      | —                                                                                                                                      |
| Launch and back hidden                     | `nuntius://launch` and `nuntius://back` say "not available in this version"                                                                                                                                                                                                   | —                                                                                                                                      |

## v1.0.1 (4 October 2026): security hardening

v1.0.1 fixes every finding of the 2 Oct Radiants Align audit in code (21 findings: 4 high, 7 medium, 8 low, 2 info), plus two issues found while answering it. Each fix, its commit and the test that proves it are in [SECURITY.md §7](SECURITY.md). In short:

- **The app checks every server-built transaction before Seed Vault opens** (`core/tx-check.ts`). The wallet must pay and sign alone, and every program must be on the action's allowlist. A grant's mint, amount, period, expiry, delegatee and token approval must be what the user typed and the screen showed; a revoke ends only the permission tapped. Anything else never reaches Seed Vault. The executor's address is pinned at build time (`EXPO_PUBLIC_EXECUTOR`); **a build without it refuses every grant**.
- **Tokens move to the Android keystore** (`expo-secure-store`), moved from v1.0.0's storage on first start, so nobody is signed out.
- **Sign-out ends the session on the server** and deletes the push tokens it registered; push tokens live only as long as their session.
- **The executor simulates every transaction before sending it**; only the over-cap demo, whose refusal must land as proof, is sent unsimulated. The devnet spike routes are gone.
- **Dependencies:** server `npm audit --omit=dev` 10 → 0; app 33 → 5, all five the `node-forge` chain (no patched release, not in the APK).
- **Subscription launches are hidden** unless the server is started with `MANDATE_LAUNCHES=1`, which stays off until the Meteora device run.

**On the device: 4 October 2026, v1.0.1 installed over v1.0.0** (`adb install -r`, an update: first install 30 Sep, versionName 1.0.1), built from `5ed747f`, server at the same commit. Every wallet tap was the owner's in Seed Vault.

| Step                                                      | Result                                                                                                                                 | Transaction                                                                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Open after the update                                     | still signed in as cj7, "✓ Seeker verified", home as before: the tokens moved to the keystore with nobody signed out                   | —                                                                                                                                      |
| Widget                                                    | still draws: "No live permissions", then the natXcheck row during the grant                                                            | —                                                                                                                                      |
| Sign out, sign in                                         | the server deleted the session and its push token (sessions 8 → 7, push tokens 1 → 0), then sign-in created new ones                   | —                                                                                                                                      |
| Grant natXcheck, 0.05 USDC a day for 7 days, 20:59:24 UTC | the transaction check passed; the line above Approve and Seed Vault both showed 0.35 USDC; one signer, cj7; `approveChecked` 0.35 USDC | [`w6tX32Tq…`](https://explorer.solana.com/tx/w6tX32TqTehhks7XPRqP68jAE9rTw5jWKqW4RZMkMjHVjbCGvsDa7YSYtiNQuiPZbmQMv9zX2GZWvC4Wq3in2ep)  |
| First pull, 20:59:31 UTC                                  | 7 s after the grant; one signer, the delegatee; 0.05 USDC; its push arrived                                                            | [`4jHvBzTP…`](https://explorer.solana.com/tx/4jHvBzTPofa1wDfCkV6xEs7azuA2YymYr7CjKhCUEX4XhFJKWcT5o1cuT3gseqZfv7u6cBXT4Hg8e5o41E8FKeaF) |
| Revoke, 21:02:09 UTC                                      | one Seed Vault sheet (Transaction, no Connect); one signer, cj7; "Token account delegate: none"                                        | [`28Y2BWPJ…`](https://explorer.solana.com/tx/28Y2BWPJkBo73ajbPY6jKf7B9iA3GLXwpWyPeTtb5nLxKcw8mjvGtumo3nXvCyrjYD8Mzd9rtADWjUFpTpMNtWG9) |
| Launch and back hidden                                    | no "Back a Seeker builder" starter; `nuntius://launch` and `nuntius://back` say "not available in this version"                        | —                                                                                                                                      |

## What this build adds (Crypto World's Fair window, from 14 Sep 2026)

| Feature                                                                                                                                                                                                                                     | Where                                       | Evidence                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **One-signature grant.** `initSubscriptionAuthority` and `createRecurringDelegation` go in one transaction, using the program's `UNKNOWN_INIT_ID` same-slot check (or the real `init_id` when the authority already exists)                 | `server/src/mandate-chain.ts`               | localnet against the real program: one required signer, delegation live with the exact terms |
| **One-signature revoke.** `revokeDelegation`, plus `revokeSubscriptionAuthority` when it is the last delegation on that mint, in one transaction                                                                                            | `mandate-chain.ts`                          | localnet: `delegate: none` after the last revoke                                             |
| **Rule-creation screen.** One sentence with four blanks; the text shown is the server's parse of the exact terms                                                                                                                            | `app/new.tsx`, `server/src/mandate-text.ts` | unit tests; rendered in the web build                                                        |
| **Hardened executor.** Idempotent per (delegation, period); a replacement is built only after the old blockhash is dead; backoff with jitter; 0x190 recorded as a refusal and receipt, never retried; revocation and expiry end the mandate | `server/src/executor.ts`                    | 15 unit tests on a simulated program and 5 localnet tests on the real one                    |
| **Guard.** Receipts for delegations nuntius did not create: foreign pulls, foreign 0x190 refusals, new permissions, revocations                                                                                                             | `server/src/guard.ts`                       | 6 localnet tests with a foreign delegatee                                                    |
| **Tier gate.** The guard is free for any wallet; Seeker verification lifts the limit from 1 mandate to 10 and adds the digest and streak                                                                                                    | `server/src/tier.ts`                        | unit and API tests                                                                           |
| **Daily clock-in.** A morning digest at an hour the user sets, and a streak of days checked in                                                                                                                                              | `server/src/digest*.ts`, `app/digest.tsx`   | unit and API tests                                                                           |
| **Home-screen widget.** Cap left and time to reset for each permission, plus the clock-in                                                                                                                                                   | `features/widget/*`, `core/widget-model.ts` | view-model and hook-free render tests; **on the Seeker, 1 Oct**: white card, rows and meters |

## The primitive

mandatum is built on **Solana Subscriptions & Allowances**, the Subscriptions Delegation Program — native, open source, audited by Cantina, built by Moonsong Labs with the Solana Foundation, announced 2 June 2026.

```
Program ID   De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44
Docs         https://solana.com/docs/payments/subscriptions/overview
Program repo https://github.com/solana-foundation/subscriptions
SDK          @solana/subscriptions 0.5.0  (kit-native, peer @solana/kit ^7)
```

The same canonical address is deployed on devnet and mainnet, so there is no per-cluster switching.

**Why the program exists.** A Solana token account can hold only _one_ approved authority at a time, which makes it impossible for a wallet to safely carry several spending arrangements for the same token. The program gives each `(user, mint)` pair a program-controlled **Subscription Authority**. The token account approves that authority once; the program then checks every requested transfer against a separate record of who may pull, how much, and when it resets or expires. **The Subscription Authority cannot move funds by itself.**

**Why the cap is the product.** The exposure is bounded by the chain, not by this codebase. An over-cap pull is rejected by the program with `custom program error: 0x190` (`amountExceedsPeriodLimit`). That is the load-bearing guarantee, and it is enforced whether or not our server behaves.

**The token approval is capped too.** `initSubscriptionAuthority` approves the Subscription Authority PDA for **`u64::MAX`** at the SPL level, and Seed Vault shows that as "Unlimited". nuntius adds an SPL `approveChecked` to the same grant transaction, after the init, that lowers the allowance to the **lifetime total**: what every live permission on that token can still take (this one included) until it expires. Every pull through the program spends from that allowance, so the **token program itself** refuses anything beyond it; when it reaches zero, SPL Token clears the delegate. A revoke that leaves other permissions lowers the allowance again. So the chain bounds two things: the program bounds each period, and the token program bounds the total.

Proven on the local validator against the real program (`server/src/allowance.localnet.test.ts`):

- the allowance is exactly the lifetime total, not `u64::MAX`;
- pulls succeed up to it, and the delegate clears itself at zero;
- a pull the program allows is refused by SPL Token (error 1) once the allowance is short;
- a second permission on the same token raises the allowance by exactly its total;
- revoking one of two lowers it to what the other can still take, and revoking the last one (even after the allowance is spent) ends with `delegate: none`.

What the cap still does not bound:

- **A later grant through another app.** Any app on this program runs init again, which resets the approval to `u64::MAX` unless that app caps it the same way. nuntius shows the live allowance on the home screen.
- **A permission with no end date on the same token** (for example a plan subscription). No finite allowance is safe for it, so nuntius leaves the approval as init set it and says so on the approve screen.
- **The destination.** The program lets the delegatee name the receiving account, and nuntius binds it off chain (SECURITY.md).

The program account is **upgradeable** (upgrade authority `DXtFpbPjcn2hxPnw79x1Pfoj35vXh5AsWBkS37YnXMVv`, measured 2026-09-22). With the token-level cap, an upgrade can no longer reach the whole balance of a delegated account. At most it can reach what you approved in total, and that total is on the approve screen before Seed Vault opens.

---

## What is proven, and on what

Nothing below is claimed from a successful build. Each line was executed and the result observed on the Seeker (`SM02E4060327059`), on chain with a signature, or against the real program on a local validator. Anything not seen on the phone is marked **UNTESTED**.

**The release:** APK `nuntius-1.0.2.apk` at https://github.com/seekdaseek/nuntius/releases/tag/v1.0.2, sha256 `fc54b8fc3badd3854e4af62bca45d04dfbc9c44901b50b06cac64da715c26faf`, signed with the release key. v1.0.1 (https://github.com/seekdaseek/nuntius/releases/tag/v1.0.1, sha256 `60aba5095d2f976e75939a3dfd1caf8f00bc7d27f49ef6533271e45cf6d6e2b8`) was signed with the same key (certificate `71:70:5E:DD…35:F8`, the one `assetlinks.json` names). The rounds below proved v1.0.0, still at https://github.com/seekdaseek/nuntius/releases/tag/v1.0.0 (sha256 `474aef66b1646419957164ea57653f3360b5936d2d13f8e52d589a626e00f9de`).

### On the Seeker, on mainnet: round 4, 1 October 2026 (build `57eb4e1`)

The release candidate. Backend at `4f541fa`. Every grant, revoke and sign-in was the owner's tap in Seed Vault. Times are UTC.

| What                                          | UTC      | Transaction                                                                                                                            | Result                                       |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| grant natXone, 0.01 USDC a day                | 08:16:29 | [`2ibgJK5z…`](https://explorer.solana.com/tx/2ibgJK5zJw82DFBbCFeU8dTkP9yMxdtmt95Yiq7zaZBUf3LCmGWMJQfGHeChvcgmwQezyc1guiQNuGQwmokHCUr6) | one signer, cj7                              |
| first pull                                    | 08:16:40 | [`4PSMS6nc…`](https://explorer.solana.com/tx/4PSMS6nccuJMiThtJwgjZFdYXu87xUgjyzMVXFLerr5ETASeYLZxzfqM1TEPd2zTtsNWWQruoxCXHLck8wepeF1s) | 11 s after the grant; the tray held one push |
| grant natXtwo, 0.01 USDC a day                | 08:19:42 | [`j2oeAPLj…`](https://explorer.solana.com/tx/j2oeAPLjYEr51MW9Tiw8eZuSvhQwcBCFPnvpq4iEB3CZZDrZatwZAbq5y1Q1h1pu4zTUXoMhxKrsUU8FMa1M3v6)  | one signer, cj7                              |
| first pull                                    | 08:19:52 | [`4ZtvWLKT…`](https://explorer.solana.com/tx/4ZtvWLKTD9tJvDGrNfqsnUdUoifwQ64XVo6z8wcbbVkWPZowon9i81JvhUEVkzhaoWuS5VgWHJyBLWYJhAx5SxeU) | 10 s after the grant                         |
| refused #1, natXone, tapped with the app open | 08:20:21 | [`4R8U6a5M…`](https://explorer.solana.com/tx/4R8U6a5MhUQBwYSQnc2XeABHfw6RGGeKrDdE4vYtoooS8JXqo36bUz3JaHEY3LS6hkJgdnYRQBmi8iTsowg8px8M) | `0x190`; its own slip opened                 |
| refused #2, natXtwo, tapped with the app open | 08:21:16 | [`2nbMHaUi…`](https://explorer.solana.com/tx/2nbMHaUiPSF4bTUxzTzF196cebYDJL7jEdeaoudHh5mrQcMnF5iYuyepKZJwFxw4H5p7zTecsnSVGYYEzu9bJvUi) | `0x190`; its own slip opened                 |
| refused #3, natXone again, same tray tag      | 08:23:07 | [`5Nam7Lma…`](https://explorer.solana.com/tx/5Nam7LmafyCBNE8t45HoiaSD1EabCwVovoiXsbjVyixVwrEe5ZLxXaK1hPP34dNFxTbm9KAmPHMX1EPegqAE4BnC) | `0x190`; its own slip opened                 |
| refused, natXtwo, tapped in the background    | 08:23:46 | [`4ZLE3GQF…`](https://explorer.solana.com/tx/4ZLE3GQFcp2GxBV7EpKcdHHm6ZtWGozwt6JQ8dn6uJdfqNc59ebTmnhs3gStHQqnzUDi1gR71hn9VoeqUvvDPTB6) | `0x190`; the slip opened                     |
| refused, natXone, tapped from a cold start    | 08:25:03 | [`3uotigam…`](https://explorer.solana.com/tx/3uotigamcH61kQtnejNZznp8HxY8y4agrgnBLwBGRZybkEa6okefGhdSDQ8JWfRhHMv4EMhrMyW3jFs3i3s325ug) | `0x190`; the slip opened, no crash           |
| revoke natXone                                | 08:28:56 | [`DZa2Vyzt…`](https://explorer.solana.com/tx/DZa2VyztDAKTmJZa4o7ARaaKb7Bik2zsh1Qrvr5BzeDPtVxobwj75TEcXGgNdnmQm2t97xU8TdmsZ5bWHvBzhKm)  | one signer, cj7                              |
| revoke natXtwo                                | 08:30:29 | [`2zZDAhNH…`](https://explorer.solana.com/tx/2zZDAhNHPRwbvrK4F8v7Et8yPnqBeqJ46nyXhMJGJYQV1f8qeuTrypKATtfcsTkSdUsuC1BBcoAADt7bxK2v3pPp) | one signer, cj7; delegate **none**           |

- **Every push tap lands where it says, in every app state.** A refused push tapped with the app open opened its own slip, three times out of three, including a second refusal for the same permission under the same tray tag. A background tap and a tap from a dead process (cold start, crash buffer empty) did too. A "received" push tapped with the app open opened its receipt.
- **A relaunch from the launcher lands on home**, three times out of three, also right after a cold-start tap: an old receipt is never reopened.
- **The tray holds one push.** After each grant "Permission live" was replaced by "received" under the same tag, and when another permission's push arrived the app dismissed the rest.
- **Nothing left behind.** All 61 token accounts of both wallets read `delegate: null` after the revokes.

What changed for round 4 (`df067cd`, `57eb4e1`, `4f541fa`): each notification tap is routed once per process from a ledger that outlives a remount, and a tap whose listener event never arrived is caught when the app comes to the front; a tap with no link (a collapsed group) opens the receipts list; a new push clears the rest of the tray; each digest link carries its send time, so two days' digests are two taps.

### Round 3, 1 October 2026 (build `67e0221`)

| What                                | UTC      | Transaction                                                                                                                            | Result                                                      |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| grant natX → cj7, 0.01 USDC a day   | 05:24:03 | [`3UqTFf5M…`](https://explorer.solana.com/tx/3UqTFf5Mr6fQBFBuNkMeDUzRXRiKp4C7GKpzcqPvLdNPMKUuGaaRhy14JQVFeYgzXUjjpVD9aKnwZaVXJYzo2FEr) | the line above Approve: "Seed Vault will show 0.07 USDC"    |
| first pull                          | 05:24:08 | [`QhkX14ZC…`](https://explorer.solana.com/tx/QhkX14ZCujPtuJN8JcD9hFYZcWigHj6cHE4L9xhoC1kUyBsaNFJtkuLbZ36JXTWTwvNocRWBetVFyQ8b3R8SiFz)  | 5 s after the grant; 7,461 units, fee 7,000 lamports        |
| grant natXcheck, 0.05 USDC a day    | 05:33:05 | [`5RQ9Hhvb…`](https://explorer.solana.com/tx/5RQ9Hhvb1GN4rKuKAP26ZahqG96upj8wbLEcoKXaRvQWf2LTphQm8tarhw7kxp8TgA8epqn9CR2hvaEJ2d6ksJis) | one signer, cj7                                             |
| first pull                          | 05:33:12 | [`5WnHgccV…`](https://explorer.solana.com/tx/5WnHgccV73Tmt7DMuUZykq9D5pyUdy7JqndQk9xLtZfE9xuD76yaXcPFtMzdtdoX3wP2qBaXQ1fjt6uEPi7zYZzs) | 7 s; "received" tapped with the app open opened the receipt |
| grant natXhourly, 0.01 USDC an hour | 05:35:48 | [`4PpGNhSh…`](https://explorer.solana.com/tx/4PpGNhShokZBYHMkH28QP3vixQjf5LSn6SvtkQZpUQGLKt5PLuyz6okchyYWkpFmeQnWV2XPALbTJLJtzDqCeXfv) | "Seed Vault will show 1.98 USDC in total"; this one 1.68    |
| grant natXthird, 0.01 USDC a day    | 05:37:22 | [`2LvREVHY…`](https://explorer.solana.com/tx/2LvREVHYtmS2MtFkUh2ZTtP9eLNuRtS7mCSNg43q6ejyYmUkqBJHFn17BnvHuSHxePQ6PzXdzkLZut4C6maZ6gMa) | the line said 2.04 USDC; **Seed Vault showed 2.04 USDC**    |
| hourly pull #2, app killed          | 06:35:49 | [`2yBvMP4j…`](https://explorer.solana.com/tx/2yBvMP4jWtxBUyt9eq6Luufbv13kPwJjVvyPktfKotJwvTqGKzEWZZvVvfdmaZ6W2BCbFtDG2Sn5n5VNb8GhajiJ) | 9,046 units, fee 7,000; cold-start tap opened the receipt   |
| last of four revokes                | 06:48:40 | [`2SWgna8v…`](https://explorer.solana.com/tx/2SWgna8vdtdxNWeDN5ckTEQwnLJ1dWXMGzguodQkCUS1ZbQBQ5Hf9sKLgC8Pz17pcnqb6Bvv3MSnivtFGPR8ppxq) | one sheet each; all 61 token accounts delegate null         |

- **The explainer is one line above Approve and names both amounts**, and it matched Seed Vault: with two USDC permissions live the third grant's line said 2.04 USDC and the Seed Vault sheet showed **2.04 USDC**. On chain right after its first pull: 2.03.
- **First pulls in 4–7 s** (5, 7, 7 and 4 s).
- **Receipts belong to their permission.** After natX's new grant, home listed only its own receipts; "See all" showed the ended `cj7check` permissions as dated sections. The deploy's start-up cleanup removed the six 22 Sep receipts the old guard had replayed.
- **No clipped text**, including the first open after a reboot; the wordmark is whole next to "✓ Seeker verified".
- **BACK** after a grant goes home; Clock in's unsaved hour is saved from the bottom bar.
- **One Seed Vault sheet per revoke** (four revokes), and all 61 token accounts of both wallets with no delegate at the end.

### Round 2, 30 September – 1 October 2026 (build `7fcd047`)

Build: public `main` at `7fcd047`, release APK signed with the release key (sha256 `23213125…9644c57`), backend `https://nuntius.ochinimus.app` on mainnet. Two Seed Vault wallets on one phone, `cj7` (Seeker verified) and `natX` (basic tier). Every grant, revoke and sign-in was approved by the owner in Seed Vault. Times are UTC.

| What                                        | UTC      | Transaction                                                                                                                            | Result                                                                              |
| ------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| grant natX → cj7, 0.01 USDC a day, 7 days   | 19:26:15 | [`4KcxTvnT…`](https://explorer.solana.com/tx/4KcxTvnTJGvQUgBvndTzzrNA5YzeDzZVEYUGGPabzS9n7bTcBA2zx4raTpRuN8am67rRsGcy3DCJ3aLwhWg4U9ym) | one signer, natX. Seed Vault showed **0.07 USDC**                                   |
| first pull, 0.01 USDC                       | 19:26:25 | [`dJaWRCMx…`](https://explorer.solana.com/tx/dJaWRCMx2n3sHHMraMJKeuGAzk3uLVmvrKET3FPpTdt9CQNJHXT75uGGnwzFzNcewK7oZhegXbKEtXVQLSPvqyC)  | 10 s after the grant; signer: the delegatee                                         |
| grant cj7 → natX, 0.05 USDC a day, 7 days   | 19:31:06 | [`gPQgHedD…`](https://explorer.solana.com/tx/gPQgHedD7ztJ2m6YpyVMF97LqX8gar5t4b5vQRRGDDesRAFNtxzPpoXZiXV34BWrUxAMWCU5SJGKoFetX7DiCaQ)  | one signer, cj7                                                                     |
| first pull, 0.05 USDC                       | 19:31:20 | [`4pdgdnee…`](https://explorer.solana.com/tx/4pdgdneetBRU5HAMq5jpqE3AZuttaRVDACYdEL57Yn1W8j1yMj9wY3vEaKcE7g8o1Kb9WgVFw6Ujz7Sg8ZENiBB1) | 14 s after the grant                                                                |
| pull 0.000001 USDC above the cap            | 19:33:02 | [`2M5biryq…`](https://explorer.solana.com/tx/2M5biryqvQY1z3LozMk7CWQyUmzsKgk7cw3euq5E4XdpTr6PTo4gG6Ht1v8nM5JaWqk7imqXpQjbGLd6cwQZhFx1) | **failed on chain, `0x190`**; 1,270 units, fee 7,000 lamports                       |
| grant cj7 → natX, 0.01 USDC an hour, 7 days | 19:35:23 | [`5Caxk6pW…`](https://explorer.solana.com/tx/5Caxk6pWbStr952NTTMRLxaETRg3c771inmTxEXECw8rtaBFZLKcHiVgwV5wipG4V5Vfq4bQKiU7Cb2CTM6JPixj) | one signer, cj7                                                                     |
| first hourly pull                           | 19:35:34 | [`4DXUzrXJ…`](https://explorer.solana.com/tx/4DXUzrXJDHcfwPRZ2nRu7iA6xvmbLQDKoiRDioLLivgs1RiDnFNcm3SVSxtwS8nmpqtbCfYvhhGSaJcAsM6SnSfm) | 11 s after the grant                                                                |
| grant cj7 → natX, 25 SKR a week, 90 days    | 19:41:54 | [`4LXBpcPM…`](https://explorer.solana.com/tx/4LXBpcPMZVnPcqmyCfeMVyZtzSAizo4j6JnU8JkbrhRepbafqyqxMMDygAP8HDqYCp13qDg3JnBD4NZcFaVNpi9G) | one signer, cj7                                                                     |
| first SKR pull, 25 SKR                      | 19:41:59 | [`Ry4tiD6o…`](https://explorer.solana.com/tx/Ry4tiD6o3u8idr6ud5s4W99AsZtasa9nubuXGBFH5zgy5ToCv45LaQ93S3912jQNhnBTKRSEQ3oBcbMAzizxxpR)  | 5 s after the grant; **5,961 compute units** (limit 40,000), **fee 7,000 lamports** |
| hourly pull #2, app killed                  | 20:35:27 | [`BdBJhbEj…`](https://explorer.solana.com/tx/BdBJhbEjmpFxfe3FbBpyZUcxHV4dfgx9sZETh1N2nhJVaQSJGqsTRb4g5juUc4Nj8CRd8kxB8DJrrB3Z1k7zuet)  | push at 20:35:33; tapped from a cold start                                          |
| hourly pull #9                              | 03:35:29 | [`63aZ4KVp…`](https://explorer.solana.com/tx/63aZ4KVppniT1mWu9czGZ5nh8e9TJrSCtxZuQTxpxxWWgANMA3GgLcjLajjtF1FhucRWBYPjhG8DfeBvwo1DJxwm) | 9,046 units, fee 7,000; nine hourly pulls, no user signature                        |
| revoke the SKR permission                   | 04:05:24 | [`4Et21Vw6…`](https://explorer.solana.com/tx/4Et21Vw684rGi86jSfzD893f5sUe99q8eYYPPK7wUXonpdNLMzfY8WeKmZ1q7K4gvcoe8fWwGM7TwoGtEoPVzqbh) | one signer, cj7                                                                     |
| revoke the hourly permission                | 04:07:05 | [`4v6pW2Gm…`](https://explorer.solana.com/tx/4v6pW2Gm376zkPh3E23HTkE3ppPjpn5bb7LBnKHMMWHGbs1GEkrF1N59rJgLUKG8to9e6kDsAzszCj5BLqEf7B8Z) | allowance trimmed to **0.30 USDC**                                                  |
| revoke the daily permission                 | 04:07:53 | [`ZdLixiQX…`](https://explorer.solana.com/tx/ZdLixiQXwmik9zaeLfUGupq4NL8AAibvArreBRbZV4sjWSQmYyqdBhMqvG4U6YNckvV4zBAyiFTEnWEJyBjYZZB)  | delegate **none**                                                                   |
| revoke natX's permission                    | 04:09:47 | [`3jD68P3P…`](https://explorer.solana.com/tx/3jD68P3PByL4zb4o3dV43p4uApxoL7SKhN3F5hP351ChQY8Xz4MV1egHuZpq7fND18XPXXdV2BgGuPVNXEazGbsb) | one signer, natX; delegate **none**                                                 |

What that run showed:

- **The token allowance is capped at the lifetime total, and Seed Vault shows it.** For natX's 0.01 USDC a day for 7 days, Seed Vault's grant sheet showed **0.07 USDC** where it used to say "Unlimited", and the token account read delegate = the Subscription Authority, delegated amount **0.07**.
- **One approval covers every live permission on a token, and a revoke trims it.** With the daily and the hourly permission live, cj7's USDC allowance read 1.97 after the first hourly pull (the daily one's 0.30 left plus the hourly one's 1.67). Revoking the hourly permission trimmed it to **0.30**, which Seed Vault showed on the revoke sheet as "0.3 USDC"; revoking the daily one left **delegate: none**.
- **First pulls land in 5–14 s** after the grant: 10 s, 14 s, 11 s and 5 s.
- **Pulls carry a compute budget.** The SKR pull used **5,961 compute units** of a 40,000 limit and paid **7,000 lamports** (5,000 base + 2,000 priority), paid by the delegatee. The user signed nothing after the grant: nine hourly pulls in a row, each signed by the delegatee alone.
- **The cap is the chain's.** A pull of one base unit above the cap landed and failed with `custom program error: 0x190`; the phone got "Refused by the chain: natXcheck" and the raspberry slip with the chain's stamp.
- **A receipt for every pull, with its meter.** Each pull's push opened a slip with the cap meter ("0 of 0.05 left today · resets in 23h 58m") and the Explorer link.
- **A tap on a killed app.** With the process gone (`pidof` empty), the hourly pull's push arrived at 20:35:33; a tap from that cold start opened its receipt, with no crash (the crash buffer stayed empty).
- **The home-screen widget** drew its white card: "nuntius", "Clocked in, day 1", one row per permission with a green meter and an ink stop. A tap opens the app.
- **The digest comes at the chosen hour, not before.** The hour was saved for 00:00 local (UTC+3) at 20:36:59; the server logged `digest_sent` at 21:00:25.635 and the push arrived at 21:00:27. Tapping it opened Clock in.
- **Sign-in, the Seeker gate and sessions.** cj7 shows "✓ Seeker verified" and Clock in; natX shows "Basic tier" before and after its one grant, and New permission is off once it holds one. After a kill (`pidof` empty) the app reopens still signed in.
- **Revoke takes one Seed Vault sheet**, the transaction itself, when the wallet is authorized. After the phone had restarted, the first revoke showed Seed Vault's "Connect" first, then the transaction.
- **Nothing left behind.** At the end, all 65 token accounts of both wallets (SPL Token and Token-2022) read `delegate: null`, and the balances reconcile to the pulls above (all account rent came back on the revokes; the net SOL cost was fees).

### Earlier on the device (9–30 September)

- **SIWS** with a backend-issued single-use nonce. Replay, expiry and domain binding all rejected. Seed Vault signs the payload field-for-field — it adds no `Version:` or `Chain ID:` line, so `verifySignIn` passes with no loosening of the check.
- **Seeker Genesis Token gate**: uniqueness is keyed on the _mint address_, not the wallet, because an SGT moves between a user's own Seed Vault accounts when the primary account changes.
- **FCM push in all three app states**, foreground, backgrounded, and killed via `am kill`.
- **MWA cancel bug fixed** (`66ab4e8`): cancel → retry → succeed three times with no restart.
- **Identity**: `https://nuntius.ochinimus.app/.well-known/assetlinks.json` lists `app.ochinimus.nuntius` with the release certificate's fingerprint, and Seed Vault sheets show the nuntius icon.

**On mainnet, with real USDC — 22 September 2026**

The full life cycle ran end to end on mainnet-beta, signed by Seed Vault on the device. Every signature below is real and openable.

| step                          | signature                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `initSubscriptionAuthority`   | `bBNbUgwhwFAmb8GM7L9AwJJjcn8UFCymrHaajLXS9R4uTTxvNUwKGVSNkj5A8EAmVuRW2PJBzjrBCuZUqGS2Sks`  |
| `createRecurringDelegation`   | `5r7YnGrbRCPb74W1t1p1xDzMtaTPL47orLsbGmpiMgAkmwbEfU9MKW7hGpZP4mcwv1cFLAXTq8pGWNsFUGinugMw` |
| `transferRecurring` ×4        | `59Zn57sY…qtjJF`, `5kSbpeH6…y1TXJ`, `3utaq3gm…VN96W`, `41emXYEH…82B5vy`                    |
| over-cap, 2× the cap          | `3RpcCkkLmwq5wT4moE1TQrXpnjRn36kWgmtRah9Y6kZuo3n5bVYdWTvnov4zQMXEr3vcS15pbE7jJENPmaZpWyR7` |
| cap exhausted in-period       | `5ryxPMPjNXzYCGtA9yQ6ZGG2enVmXjyN9PnotF9x1h7N9MqZjS5Kk9K1YQsh4661Hn7xNPhn1N6pcoQ1TKAjsDpd` |
| `revokeDelegation`            | `Vh2yr9VTe8YeqcGqffuVZEa26ZicoJP3FV5k8y4FYNXtECCEXu6bvbWZ6u8XuRXWP6XSp5hxUpq1X97TYmsb1wT`  |
| `revokeSubscriptionAuthority` | `2doDFNXUxvBcstNJJDwjWCyrEGMLEugQAUeXTth4eCJnsXHb3S89s17Jtr34Raxg25vwQF1MGTC5cMFjgVsij9Y8` |
| pull after revocation         | `cfESoUjxbXF341RwzBtqyuBMAZ7rwA6mhbJCqQ1fqs91Gc48eFd5yzqLfT2vnazxJwB2JL7WcuSqzEzTtM5GPzm`  |

- **Seed Vault signs a delegation on mainnet.** The devnet block was never a code fault — the wallet's own network is mainnet, so it refused a devnet transaction as a network mismatch. On mainnet there is no mismatch and it signs.
- **The user signs nothing after authorizing.** Every `transferRecurring` above has exactly **one** signer, the delegatee, and the delegator is not among the signers. Verified from each transaction's recorded account keys, not from intent.
- **The cap is the chain's, not ours.** A pull of 2× the cap, and a pull of one extra base unit after the cap was consumed, both failed with `custom program error: 0x190` (`amountExceedsPeriodLimit`). Both were sent with preflight disabled so the rejection is a **landed mainnet transaction**, not a simulation the RPC refused.
- **The period resets.** After the 60-second window rolled over, the same delegation allowed a further pull with no new user signature.
- **Revocation is complete.** After `revokeDelegation` then `revokeSubscriptionAuthority`, both PDAs are closed and the token account reads `delegate: none`. A subsequent pull dies on chain with `InvalidAccountOwner`.

Cap was 10,000 base units (0.01 USDC) per 60-second period. 17,000 base units moved in total across four pulls. The delegator's SOL ended 112,000 lamports down — both account rents were returned by the revokes.

**On localnet — the real program, built from source (measured 2026-10-04)**

The build environment cannot reach devnet or mainnet. Instead, `scripts/localnet.sh` builds `solana-foundation/subscriptions` at **`364a419`**, the commit the program's CHANGELOG names as the mainnet release, and loads it at its canonical address in `solana-test-validator` (Agave 3.1.10). Binary sha256: `31309d4202746b1af2040b792c127cde51cd549b5738096603e4504a30974648`. Whether this binary is byte-identical to mainnet is **not measured** yet. The check: `solana-verify get-program-hash` on mainnet against `solana-verify build --library-name subscriptions_program` at `364a419`.

```
$ LOCALNET_RPC=http://127.0.0.1:8899 npm --prefix server test
ℹ tests 117
ℹ pass 117
ℹ fail 0
```

These tests cover:

- **One-signature grant**: exactly one required signer, and the token account delegate is the authority PDA, capped at the lifetime total (not `u64::MAX`).
- **Pulls**: signed by the delegatee alone.
- **Refusals**: an over-cap pull and a pull of one base unit over are both refused with `{"Custom":400}` and move nothing.
- **Second mandate on the same authority**: uses the real `init_id`.
- **Revoke**: one-signature revoke that keeps the authority while another mandate needs it and clears it with the last one.
- **Executor**: pulls, rolls the period and pulls again with no user signature, lands a real 0x190, and notices a revoke.
- **Guard**: sends receipts for a foreign delegatee.
- **HTTP API**: the whole surface, driven exactly as the app drives it.

**Not yet proven**

- **The digest on the release build.** The round-3 build sent its digest at the chosen hour; on `57eb4e1` the next one is due at 21:00 UTC on 1 October, with the title "since your last digest" and BACK from Clock in opened by its push. **PENDING.**
- **The widget on builds after round 2.** It rendered on the Seeker on 30 Sep (round 2); rounds 3 and 4 did not recheck it.
- **The mainnet program binary.** The local tests build the program at `364a419`; whether that is byte-identical to the mainnet deployment is not measured.
- **Executor limits.** The executor runs as a single process, and the delegatee key is a file, not a KMS (SECURITY.md §4).

---

## SKR payments

nuntius offers **SKR next to USDC**: recurring SKR payments, approved once in Seed Vault and capped by the chain. It is the same Subscriptions program and the same one-transaction grant. Each `(user, mint)` pair gets its own Subscription Authority, so an SKR permission and a USDC permission are separate delegations on separate token accounts, and each can be revoked on its own. This is not staking; SKR moves as a payment.

- **Mint.** `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`, SPL Token program, 6 decimals (read on mainnet on 30 Sep 2026).
- **Server.** `MANDATE_MINTS=SYMBOL:mint:decimals[:maxPerPeriod],…`. Each mint has its own beta ceiling per period. Mainnet defaults to USDC plus SKR, with an SKR ceiling of 55 SKR per period: about 1 USD at 0.0181 USD per SKR, the price read on 30 Sep 2026. `SKR_CEILING=<n>` on the deploy overrides it only if the price moves a lot.
- **Two uses, one tap each.** When the server offers SKR, New permission shows two starters above the sentence. **Back a Seeker builder** fills 25 SKR every week for 90 days (with subscription launches on, it opens the launch flow instead); **Allowance in SKR** fills 50 SKR every week for 30 days. A starter fills the sentence only: the payee is always entered by hand, and Approve stays off until it is. `core/core.test.ts` tests the starters; `docs/screens/web/02b-new-permission-skr-starter.png` shows one tapped.
- **App.** The token choice on New permission shows only what the server offers. Receipts, the widget, the digest and the home sentence carry each mint's own symbol and decimals.
- **Evidence.** `server/src/mints.localnet.test.ts` runs two test mints against the real program: per-mint ceilings, one authority per mint (each granted with one signature), the executor pulling both, and receipts and widget rows with the right symbols. On mainnet from the Seeker: a 25 SKR a week grant on 30 Sep at 19:41:54 UTC ([`4LXBpcPM…`](https://explorer.solana.com/tx/4LXBpcPMZVnPcqmyCfeMVyZtzSAizo4j6JnU8JkbrhRepbafqyqxMMDygAP8HDqYCp13qDg3JnBD4NZcFaVNpi9G), one signer, cj7), its first pull 5 s later at 19:41:59 UTC and 5,961 compute units ([`Ry4tiD6o…`](https://explorer.solana.com/tx/Ry4tiD6o3u8idr6ud5s4W99AsZtasa9nubuXGBFH5zgy5ToCv45LaQ93S3912jQNhnBTKRSEQ3oBcbMAzizxxpR), one signer, the delegatee), the receipt "25 SKR · 0 of 25 left this week", and the revoke on 1 Oct at 04:05:24 UTC ([`4Et21Vw6…`](https://explorer.solana.com/tx/4Et21Vw684rGi86jSfzD893f5sUe99q8eYYPPK7wUXonpdNLMzfY8WeKmZ1q7K4gvcoe8fWwGM7TwoGtEoPVzqbh), one signer, cj7). The code behind it: `server/src/mandate-config.ts` (the SKR mint and its 55 SKR per-period ceiling), `core/mandate-form.ts` (the two starters) and `app/new.tsx` (the starter buttons).

## Subscription launches (Meteora)

**In v1.0.1 and v1.0.2 these screens are hidden** unless the server is started with `MANDATE_LAUNCHES=1`; it stays off until the Meteora device run. Everything below describes the feature as built and tested.

A builder launches a token on a Meteora **Dynamic Bonding Curve** (DBC), priced in SKR or USDC. Backers grant a capped recurring permission in one Seed Vault approval: _"Back NATX: 5 USDC every week, for 90 days."_ Every period, one executor transaction:

1. pulls the backer's amount through the Subscriptions program, which enforces the cap, into nuntius's own quote account;
2. buys the launch token with exactly that amount: a `swap2` exact-in with a 2% minimum-out;
3. writes the bought tokens straight into the **backer's own token account**, which the backer created in the grant transaction.

If the swap cannot meet its minimum-out, the whole transaction fails and nothing is pulled. The receipt then reads _"Skipped: the price moved more than 2%. Nothing was taken."_ and the buy is tried again later in the period. When backers fill the curve, the pool migrates to **DAMM v2** and the buy follows the token there. A permission waits rather than buying while the curve is migrating.

**Custody invariant.** The executor's quote and base balances are the same after every buy as before it: the pull lands and the exact-in swap spends all of it in the same transaction, and the output goes to the backer. Exact-in either fills completely or fails; it never part-fills. Near the end of the curve the buy is cut to what the curve still takes, so the last buy does not fail forever. Asserted in `server/src/executor-back.test.ts`; on mainnet, in the 1 October simulations (below).

**What the cap still bounds, and what it does not.** The Subscriptions program bounds how much quote leaves the backer per period and over the permission's life (the finite allowance Seed Vault shows). It does not bound the price: the 2% minimum-out bounds slippage per buy, and a curve's price rises as it fills. A backer who wants out revokes with one approval; the tokens already bought are in their own wallet.

**The launch preset** (`server/src/meteora.ts`, `launchPreset`) is made for many small, regular buys:

| Choice                                                       | Why                                                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Flat 1% fee from the first buy                               | No launch fee scheduler, so a weekly backer pays what a day-one buyer pays, and there is no early window to front-run                    |
| Fees collected in the quote token                            | The creator's 50% share accrues in SKR or USDC, not in the launched token                                                                |
| 1 billion supply, 6 decimals, 20% kept for the migrated pool | A plain, readable supply                                                                                                                 |
| Migration to DAMM v2 at a small threshold                    | 50,000 SKR or 1,000 USDC, so a launch backed by a few people's weekly buys reaches its regular pool                                      |
| All LP permanently locked at migration                       | Liquidity cannot be pulled                                                                                                               |
| Metadata immutable                                           | The metadata JSON is served at `/m/<mint>.json`. The URI is kept under 100 characters, so the launch transaction stays under 1,232 bytes |

**In the app:**

- **Back a launch:** paste a pool. The "Back a Seeker builder" starter opens this flow.
- **Launch a token:** verified Seekers only, one signature.
- **The permission card:** what it buys, what it has bought, and the curve's progress.
- **Receipts:** "Bought 1234 NATX for 5 USDC" with an Explorer link, and skip receipts.

`GET /api/launch/:pool` is public and read-only. It serves curve progress, the route, and the launch's committed recurring demand: active backing caps, per week, and the number of backers.

**Proven on mainnet by simulation, 1 October.** Read-only, from the Mac, with no signature: `tools/mac/09-spike-dbc.sh` on the ops branch.

| Transaction             | Size                               | Compute                             | Result                                                                                  |
| ----------------------- | ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| Buy on a live DBC pool  | 858 B                              | 38,869 CU (pull 8,661, swap 29,908) | Executor's quote account 0 before and after; tokens with the backer                     |
| Buy on a DAMM v2 pool   | 825 B                              | 25,611 CU                           | The same                                                                                |
| Grant + ATA instruction | 580 B                              | 29,566 CU                           | Allowance finite (5,000,000 base units, not u64::MAX)                                   |
| Launch                  | 1,093 B, signed once by the device | —                                   | Stopped on rent: the account had 0.0228 SOL. Proven on the device with a funded account |

## Architecture

```
Seeker (React Native, Expo SDK 55, expo-router)
  │  MWA + Seed Vault  — signs ONE transaction per grant or revoke; never holds a server key
  │  FCM               — receipts on the HIGH `alerts` channel, the digest on the quiet `digest` channel
  │  home-screen widget — headless render from /api/widget, cached for offline
  ▼
Node backend (Express 5, TypeScript ESM, SQLite)
  │  mandates API       — preview, create (unsigned tx), confirm-against-chain, list, revoke
  │  executor           — pulls once per (delegation, period); idempotent ledger; backoff
  │  guard              — every delegation on the wallet: foreign pulls, refusals, new grants, revokes
  │  digest scheduler   — once per local day at the user's hour (Seeker tier)
  │  allowlisted RPC proxy — the Helius key never enters the app bundle
  ▼
Solana Subscriptions program  De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44
```

The device never carries the subscriptions SDK. The server composes instructions with the SDK's overlay builders and hands the phone base64 bytes in which the user is fee payer and sole signer. `@solana/kit` v7 stays on the server; the app resolves v6.

Push is sent as **`notification` + `data`**, not data-only. A data-only FCM message returns 200 but never wakes a killed app without a background task, and waking a phone the user is not holding is the entire point. This was proven on device on 2026-09-09.

---

## Run it

### Tests

```bash
npm ci && npm run test:core                 # 46 app-logic tests: taps, widget model, form checks, the fill, transaction check, storage, shims
npm run test:e2e                            # 12 tests on the web build: cold-start tap, fonts, layout, BACK, the builder starter, Fill offline
npx tsc --noEmit && npx expo lint && npx prettier --check .

cd server && npm ci
npm test                                    # 89 unit tests (Type it your way with a mocked model); the 7 localnet suites report "skipped"
../scripts/localnet.sh &                    # validator + the program built from 364a419 (first run builds it)
npm run test:localnet                       # all 130, against the real program
```

### Backend

```bash
cd server && npm ci && npm run build && npm start
```

Listens on `127.0.0.1:8787`, loopback only. Configuration comes from `server/.env`, which is gitignored. Every variable is listed with placeholders in [`server/.env.example`](server/.env.example). Mandates are off unless `MANDATE_CLUSTER` is set. **Type it your way** needs `ANTHROPIC_API_KEY`; without it `/api/parse-permission` answers that it could not read the text, and the form works as before. On mainnet the executor key must already exist at `MANDATE_DELEGATEE` and be funded for fees; the server will not invent a mainnet key. Endpoint semantics for auth, SGT and push are in [`server/README.md`](server/README.md); the mandate routes are documented at the top of [`server/src/mandates-api.ts`](server/src/mandates-api.ts).

### App

The app needs a real Android device. Mobile Wallet Adapter uses Kotlin native modules, so **Expo Go will not work**. A release build needs `EXPO_PUBLIC_API_BASE` set to the backend's HTTPS URL, and the four `NUNTIUS_UPLOAD_*` Gradle properties for the release key (see [`plugins/with-release-signing.js`](plugins/with-release-signing.js)); without them it is signed with the debug key.

```bash
npm ci
npx expo prebuild -p android
cd android && ANDROID_HOME=/path/to/android-sdk ./gradlew app:assembleDebug --no-daemon -PreactNativeArchitectures=arm64-v8a
cd .. && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8787 tcp:8787 && adb reverse tcp:8081 tcp:8081
npm run dev
```

The screens can also be rendered in a browser for review: `npx expo export -p web`, then run `server/src/tools/preview-server.ts` against a localnet. Wallet signing does not exist on web.

---

## Security posture

The full threat model is in [SECURITY.md](SECURITY.md). In short:

- The per-period cap is enforced by the program, not by this code.
- The SPL approval behind it is capped at the lifetime total of the live permissions, so even a program upgrade reaches at most what you approved in total.
- The destination of a pull is bound by nuntius, not by the chain.
- The model behind **Fill** only fills the form: it never signs, never picks an address and never moves money. Plain code checks every term it proposes, and the transaction check and the chain's cap bound the grant as for typed terms (SECURITY.md §4b).
- There are no secrets in the repository. `.env`, keystores, the Firebase service account, `google-services.json` and the delegatee key are gitignored.
- Logs are JSON with API keys, keypairs and session and FCM tokens redacted.
- SIWS nonces are single-use and atomic, and sessions expire after 30 days.
- The legacy devnet spike routes (`/api/delegation/*`) were removed in v1.0.1; nothing in the app used them.
- `/api/rpc`, the SIWS routes and the demo route are rate-limited per client IP (429 with JSON).
- The MWA app identity is `https://nuntius.ochinimus.app`. That host serves its own `/.well-known/assetlinks.json` and icon.
- Server `npm audit --omit=dev`: 0 vulnerabilities (5 Oct, with `@anthropic-ai/sdk` 0.131.0). App: 5 high, all the `node-forge` chain in Expo's build tools, which has no patched release and is not in the APK (SECURITY.md §5).

---

## Prior work

**Disclosure, as the Colosseum rules require.**

- **Before the window.** This repository was created on **9 September 2026**. **41 commits are dated 9–10 September 2026**, before the Crypto World's Fair window opened on 14 September 2026. That work was done for the Solana Mobile × RadiantsDAO _Clock In_ hackathon, whose window opened on 8 September. It is: SIWS auth, the Seeker Genesis Token gate, FCM push in all app states, the MWA cancel fix, and the devnet delegation spike.
- **In the window.** From `819382d` (22 September) onward: the mainnet delegation path and the landed mainnet proof (22 September), then everything in _What this build adds_ above.
- **Hashes and history.** Measure the split with `git log --before=2026-09-14 --oneline | wc -l`. Commit history up to `f25a9e9` is unrewritten. Later commits keep their original timestamps (author and committer dates) and are published under the repository owner's name.
- **No reused code.** Everything in this repository was written for these two events. **No code was reused** from any earlier project.
- **Third-party components.** The vendored component is `.agents/skills/solana-dev`, the Solana Foundation's published development skill, included under its own MIT licence and pinned by hash in `skills-lock.json`. The on-chain program is the Foundation's Subscriptions program, used as deployed. Its source is only fetched and built for local tests by `scripts/localnet.sh`; nothing of it is vendored here. Meteora's DBC and DAMM v2 are reached through their MIT SDKs, `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 and `@meteora-ag/cp-amm-sdk` 1.5.1 (both MIT on npm, re-checked 1 Oct 2026). Meteora's programs are used as deployed; none of their source is fetched, built or vendored. Through those SDKs the server also depends on `@solana/web3.js` 1.x. That brings in `rpc-websockets` (LGPL-3.0-only), used unmodified as a library, and `chain` (MIT), which cp-amm-sdk lists but never imports.

---

## Licence

MIT — see [LICENSE](LICENSE).
