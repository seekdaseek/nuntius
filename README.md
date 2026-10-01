# nuntius — mandatum

**Grant a payment once in Seed Vault. The chain holds the line. Your phone gets a receipt for every pull, including the ones the chain refused.**

`nuntius` is the app. **mandatum** is what it does: a capped, revocable, recurring on-chain payment authority. The user fills in one sentence (_"Rent to Ana can receive up to 25 USDC every week, until 26 Dec 2026"_) and approves it with **one** Seed Vault signature. After that, payments run on schedule while the phone stays in a pocket. Anything above the cap is rejected by the Solana Subscriptions program itself, with custom error `0x190`. Every pull, and every refusal, arrives as a push that opens the on-chain proof. Revoking is also one signature.

nuntius also works as a **permission manager for the whole Subscriptions standard**. It lists every delegation the wallet has granted, whether to nuntius or to any other app. It sends a receipt when _any_ delegatee pulls. It flags permissions that were created outside nuntius, and it revokes any of them with one approval.

Built for the Solana Seeker. Android only: Mobile Wallet Adapter and Seed Vault are the mechanism, not decoration.

|                              |                                                                      |
| ---------------------------- | -------------------------------------------------------------------- |
| Judges, start here           | [JUDGE_GUIDE.md](JUDGE_GUIDE.md): install and verify in five minutes |
| Threat model                 | [SECURITY.md](SECURITY.md): what the cap bounds and what it does not |
| Why this, not something else | [RESEARCH.md](RESEARCH.md)                                           |

---

## What this build adds (Crypto World's Fair window, from 14 Sep 2026)

| Feature                                                                                                                                                                                                                                     | Where                                       | Evidence                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **One-signature grant.** `initSubscriptionAuthority` and `createRecurringDelegation` go in one transaction, using the program's `UNKNOWN_INIT_ID` same-slot check (or the real `init_id` when the authority already exists)                 | `server/src/mandate-chain.ts`               | localnet against the real program: one required signer, delegation live with the exact terms |
| **One-signature revoke.** `revokeDelegation`, plus `revokeSubscriptionAuthority` when it is the last delegation on that mint, in one transaction                                                                                            | `mandate-chain.ts`                          | localnet: `delegate: none` after the last revoke                                             |
| **Rule-creation screen.** One sentence with four blanks; the text shown is the server's parse of the exact terms                                                                                                                            | `app/new.tsx`, `server/src/mandate-text.ts` | unit tests; rendered in the web build                                                        |
| **Hardened executor.** Idempotent per (delegation, period); a replacement is built only after the old blockhash is dead; backoff with jitter; 0x190 recorded as a refusal and receipt, never retried; revocation and expiry end the mandate | `server/src/executor.ts`                    | 12 unit tests on a simulated program and 4 localnet tests on the real one                    |
| **Guard.** Receipts for delegations nuntius did not create: foreign pulls, foreign 0x190 refusals, new permissions, revocations                                                                                                             | `server/src/guard.ts`                       | 5 localnet tests with a foreign delegatee                                                    |
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

### On the Seeker, on mainnet: 30 September – 1 October 2026

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

**On localnet — the real program, built from source (measured 2026-10-01)**

The build environment cannot reach devnet or mainnet. Instead, `scripts/localnet.sh` builds `solana-foundation/subscriptions` at **`364a419`**, the commit the program's CHANGELOG names as the mainnet release, and loads it at its canonical address in `solana-test-validator` (Agave 3.1.10). Binary sha256: `31309d4202746b1af2040b792c127cde51cd549b5738096603e4504a30974648`. Whether this binary is byte-identical to mainnet is **not measured** yet. The check: `solana-verify get-program-hash` on mainnet against `solana-verify build --library-name subscriptions_program` at `364a419`.

```
$ LOCALNET_RPC=http://127.0.0.1:8899 npm --prefix server test
ℹ tests 83
ℹ pass 83
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

- **This round's fixes, on the phone.** A "received" push tapped while the app is open, receipts split into live and ended permissions, the one-line explainer above Approve, text drawn only after the fonts load, the wordmark next to the Seeker chip, BACK after a grant and from Clock in, and the digest's "since your last digest" wording are tested in unit, localnet and web tests, but not yet on the Seeker. **UNTESTED on device.**
- **Seed Vault's grant sheet when one approval covers two permissions.** The allowance on chain was read (1.97 USDC), but the sheet itself was not captured. **UNTESTED on device.**
- **The mainnet program binary.** The local tests build the program at `364a419`; whether that is byte-identical to the mainnet deployment is not measured.
- **Executor limits.** The executor runs as a single process, and the delegatee key is a file, not a KMS (SECURITY.md §4).

---

## SKR payments

nuntius offers **SKR next to USDC**: recurring SKR payments, approved once in Seed Vault and capped by the chain. It is the same Subscriptions program and the same one-transaction grant. Each `(user, mint)` pair gets its own Subscription Authority, so an SKR permission and a USDC permission are separate delegations on separate token accounts, and each can be revoked on its own. This is not staking; SKR moves as a payment.

- **Mint.** `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`, SPL Token program, 6 decimals (read on mainnet on 30 Sep 2026).
- **Server.** `MANDATE_MINTS=SYMBOL:mint:decimals[:maxPerPeriod],…`. Each mint has its own beta ceiling per period. Mainnet defaults to USDC plus SKR, with an SKR ceiling of 55 SKR per period: about 1 USD at 0.0181 USD per SKR, the price read on 30 Sep 2026. `SKR_CEILING=<n>` on the deploy overrides it only if the price moves a lot.
- **Two uses, one tap each.** When the server offers SKR, New permission shows two starters above the sentence. **Back a Seeker builder** fills 25 SKR every week for 90 days; **Allowance in SKR** fills 50 SKR every week for 30 days. A starter fills the sentence only: the payee is always entered by hand, and Approve stays off until it is. `core/core.test.ts` tests the starters; `docs/screens/web/02b-new-permission-skr-starter.png` shows one tapped.
- **App.** The token choice on New permission shows only what the server offers. Receipts, the widget, the digest and the home sentence carry each mint's own symbol and decimals.
- **Evidence.** `server/src/mints.localnet.test.ts` runs two test mints against the real program: per-mint ceilings, one authority per mint (each granted with one signature), the executor pulling both, and receipts and widget rows with the right symbols. On mainnet from the Seeker (1 Oct): a 25 SKR a week grant, its first pull 5 s later at 5,961 compute units, the receipt "25 SKR · 0 of 25 left this week", and the revoke.

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
npm ci && npm run test:core                 # app logic: widget model, form checks, formatting (node --test)
npm run test:e2e                            # the web build: cold-start tap, fonts, layout, BACK (playwright-core)
npx tsc --noEmit && npx expo lint && npx prettier --check .

cd server && npm ci
npm test                                    # unit tests; localnet suites report "skipped"
../scripts/localnet.sh &                    # validator + the program built from 364a419 (first run builds it)
npm run test:localnet                       # everything, against the real program
```

### Backend

```bash
cd server && npm ci && npm run build && npm start
```

Listens on `127.0.0.1:8787`, loopback only. Configuration comes from `server/.env`, which is gitignored. Every variable is listed with placeholders in [`server/.env.example`](server/.env.example). Mandates are off unless `MANDATE_CLUSTER` is set. On mainnet the executor key must already exist at `MANDATE_DELEGATEE` and be funded for fees; the server will not invent a mainnet key. Endpoint semantics for auth, SGT and push are in [`server/README.md`](server/README.md); the mandate routes are documented at the top of [`server/src/mandates-api.ts`](server/src/mandates-api.ts).

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
- There are no secrets in the repository. `.env`, keystores, the Firebase service account, `google-services.json` and the delegatee key are gitignored.
- Logs are JSON with API keys, keypairs and session and FCM tokens redacted.
- SIWS nonces are single-use and atomic, and sessions expire after 30 days.
- The legacy spike routes exist only with `SPIKE_ROUTES=1`.
- `/api/rpc`, the SIWS routes and the demo route are rate-limited per client IP (429 with JSON).
- The MWA app identity is `https://nuntius.ochinimus.app`. That host serves its own `/.well-known/assetlinks.json` and icon.
- Server `npm audit`: 0 vulnerabilities. App: 14 moderate, all transitive through the Expo SDK 55 toolchain (SECURITY.md §5).

---

## Prior work

**Disclosure, as the Colosseum rules require.**

- **Before the window.** This repository was created on **9 September 2026**. **41 commits are dated 9–10 September 2026**, before the Crypto World's Fair window opened on 14 September 2026. That work was done for the Solana Mobile × RadiantsDAO _Clock In_ hackathon, whose window opened on 8 September. It is: SIWS auth, the Seeker Genesis Token gate, FCM push in all app states, the MWA cancel fix, and the devnet delegation spike.
- **In the window.** From `819382d` (22 September) onward: the mainnet delegation path and the landed mainnet proof (22 September), then everything in _What this build adds_ above.
- **Hashes and history.** Measure the split with `git log --before=2026-09-14 --oneline | wc -l`. Commit history up to `f25a9e9` is unrewritten. Later commits keep their original timestamps (author and committer dates) and are published under the repository owner's name.
- **No reused code.** Everything in this repository was written for these two events. **No code was reused** from any earlier project.
- **Third-party components.** The vendored component is `.agents/skills/solana-dev`, the Solana Foundation's published development skill, included under its own MIT licence and pinned by hash in `skills-lock.json`. The on-chain program is the Foundation's Subscriptions program, used as deployed. Its source is only fetched and built for local tests by `scripts/localnet.sh`; nothing of it is vendored here.

---

## Licence

MIT — see [LICENSE](LICENSE).
