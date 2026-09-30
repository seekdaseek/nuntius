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
| **Home-screen widget.** Cap left and time to reset for each permission, plus the clock-in                                                                                                                                                   | `features/widget/*`, `core/widget-model.ts` | view-model unit tests; `expo prebuild` generates the receiver. On-device: **UNTESTED**       |

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

**What the cap does not bound, stated plainly.** `initSubscriptionAuthority` approves the Subscription Authority PDA for **`u64::MAX`** at the SPL level — the Foundation's own architecture diagram labels it exactly that. The per-period cap lives in the delegation record the program checks, not in the token account's approval. So while an authority is live, what stands between a delegatee and the _whole_ token-account balance is the program behaving correctly. Keep the balance of a delegated account near what the delegation actually needs, and revoke when done.

The program account is **upgradeable** (upgrade authority `DXtFpbPjcn2hxPnw79x1Pfoj35vXh5AsWBkS37YnXMVv`, measured 2026-09-22). That is a real dependency risk, disclosed rather than glossed, and it is exactly why the per-period cap rather than trust is what bounds a user's exposure.

---

## What is proven, and on what

Nothing below is claimed from a successful build. Each line was executed and the result observed on the real Seeker, device `SM02E4060327059`, or on-chain with a signature.

**On the device**

- **SIWS** with a backend-issued single-use nonce. Replay, expiry and domain binding all rejected. Seed Vault signs the payload field-for-field — it adds no `Version:` or `Chain ID:` line, so `verifySignIn` passes with no loosening of the check.
- **Seeker Genesis Token gate** — the SGT check returns the device wallet's mint, and uniqueness is keyed on the _mint address_, not the wallet, because an SGT moves between a user's own Seed Vault accounts when the primary account changes.
- **FCM push in all three app states** — foreground, backgrounded, and killed via `am kill`. Warm tap-through routes to the alert screen.
- **Release-build cold-start tap-through** — from a zero-process release build, a push tap cold-launches straight to the alert screen with the right payload, splash intact.
- **MWA cancel bug fixed** (`66ab4e8`) — the wallet kit replayed a cached `auth_token` and never cleared it, bricking every later sign-in. Now it authorizes fresh inside a low-level `transact` session. Proven cancel → retry → succeed three times with no restart.

**On-chain (devnet, real signatures in git history)**

- An over-cap pull is rejected by the program: `custom program error: 0x190` = `amountExceedsPeriodLimit`. Enforcement is the program's, not ours.
- After `revokeDelegation` the delegation account ceases to exist and a further pull dies with `Invalid account owner`; `revokeSubscriptionAuthority` then leaves `userAta delegate: none`. **`closeSubscriptionAuthority` is never used** — it leaves the SPL delegate live and would report a false pass.
- Pull → FCM push → tap → evidence screen showing moved / remaining / reset / Explorer link.

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

**On localnet — the real program, built from source (2026-09-27)**

The build environment cannot reach devnet or mainnet. Instead, `scripts/localnet.sh` builds `solana-foundation/subscriptions` at **`364a419`**, the commit the program's CHANGELOG names as the mainnet release, and loads it at its canonical address in `solana-test-validator` (Agave 3.1.10). Binary sha256: `31309d4202746b1af2040b792c127cde51cd549b5738096603e4504a30974648`. Whether this binary is byte-identical to mainnet is **not measured** yet. The check: `solana-verify get-program-hash` on mainnet against `solana-verify build --library-name subscriptions_program` at `364a419`.

```
$ LOCALNET_RPC=http://127.0.0.1:8899 npm --prefix server test
ℹ tests 51
ℹ pass 51
ℹ fail 0
```

These tests cover:

- **One-signature grant**: exactly one required signer, and the token account delegate is the authority PDA at `u64::MAX`.
- **Pulls**: signed by the delegatee alone.
- **Refusals**: an over-cap pull and a pull of one base unit over are both refused with `{"Custom":400}` and move nothing.
- **Second mandate on the same authority**: uses the real `init_id`.
- **Revoke**: one-signature revoke that keeps the authority while another mandate needs it and clears it with the last one.
- **Executor**: pulls, rolls the period and pulls again with no user signature, lands a real 0x190, and notices a revoke.
- **Guard**: sends receipts for a foreign delegatee.
- **HTTP API**: the whole surface, driven exactly as the app drives it.

**Not yet proven**

- **Seed Vault signing the one-transaction grant on the Seeker, on mainnet.** The two-transaction grant was signed on mainnet on 22 Sep. The one-transaction version is proven only on localnet so far. **UNTESTED on device.**
- **Parts of the app not yet exercised on the phone.** The new screens, the widget, persisted sessions and the digest push have been rendered only in a web build against localnet, not on the phone. **UNTESTED on device.**
- **Executor limits.** The executor runs as a single process, and the delegatee key is a file, not a KMS (SECURITY.md §4).

---

## SKR payments

nuntius offers **SKR next to USDC**: recurring SKR payments, approved once in Seed Vault and capped by the chain. It is the same Subscriptions program and the same one-transaction grant. Each `(user, mint)` pair gets its own Subscription Authority, so an SKR permission and a USDC permission are separate delegations on separate token accounts, and each can be revoked on its own. This is not staking; SKR moves as a payment.

- **Mint.** `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`, SPL Token program, 6 decimals (read on mainnet on 30 Sep 2026).
- **Server.** `MANDATE_MINTS=SYMBOL:mint:decimals[:maxPerPeriod],…`. Each mint has its own beta ceiling per period. Mainnet defaults to USDC plus SKR, with an SKR ceiling of 55 SKR per period: about 1 USD at 0.0181 USD per SKR, the price read on 30 Sep 2026. `SKR_CEILING=<n>` on the deploy overrides it only if the price moves a lot.
- **Two uses, one tap each.** When the server offers SKR, New permission shows two starters above the sentence. **Back a Seeker builder** fills 25 SKR every week for 90 days; **Allowance in SKR** fills 50 SKR every week for 30 days. A starter fills the sentence only: the payee is always entered by hand, and Approve stays off until it is. `core/core.test.ts` tests the starters; `docs/screens/web/02b-new-permission-skr-starter.png` shows one tapped.
- **App.** The token choice on New permission shows only what the server offers. Receipts, the widget, the digest and the home sentence carry each mint's own symbol and decimals.
- **Evidence.** `server/src/mints.localnet.test.ts` runs two test mints against the real program: per-mint ceilings, one authority per mint (each granted with one signature), the executor pulling both, and receipts and widget rows with the right symbols. SKR on mainnet from the Seeker is **UNTESTED** until the device checklist runs.

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
- The SPL approval behind it is `u64::MAX`, and the program is upgradeable. Both are stated plainly.
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
