# nuntius — mandatum

**Money that moves without you opening the app: a capped, revocable, recurring on-chain payment authority you grant once in Seed Vault, and a push that arrives as the receipt.**

`nuntius` is the app. **mandatum** is what it does — a recurring delegation the user authorizes a single time, after which a delegatee may pull up to a hard per-period cap, on schedule, while the phone stays in a pocket. Every pull fires a push that taps through to evidence: how much moved, how much is left this period, when the cap resets, and a link to the transaction. Revocation is one transaction and the user owns it.

Built for the Solana Seeker. Android only — Mobile Wallet Adapter and Seed Vault are the mechanism, not decoration.

---

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

**Not yet proven**

- **Mainnet authorization through Seed Vault.** On devnet the wallet refuses to sign, because the Seed Vault Wallet's own network is set to mainnet and it reports a network mismatch — a wallet setting, not a code fault; the transaction parsed correctly. The mainnet run is the open item. Until it is executed and observed, treat mainnet Seed Vault signing as untested.
- The executor is a single in-process timer. Durability, leader election, delegatee fee funding, KMS custody and observability are documented as production needs in `server/src/executor.ts` rather than half-built.

---

## Architecture

```
Seeker (React Native, Expo SDK 55, expo-router)
  │  MWA + Seed Vault  — signs; never holds a server key
  │  FCM               — notification + data, routed to the `alerts` channel
  ▼
Node backend (Express 5, TypeScript ESM, SQLite)
  │  builds every transaction with the subscriptions SDK's overlay builders,
  │  hands the device ONE base64 transaction to sign
  │  allowlisted RPC proxy — the Helius key never enters the app bundle
  ▼
Subscriptions Delegation Program (mainnet)
```

The device never carries the subscriptions SDK. The server composes instructions with the SDK's `get*OverlayInstruction*` builders, which return plain Kit `Instruction`s, so `@solana/kit` v7 stays out of the app bundle while the app resolves v6 at its root.

Push is sent as **`notification` + `data`**, not data-only: a data-only FCM message returns 200 but never wakes a killed app without a background task, and waking a phone the user is not holding is the entire point.

---

## Run it

### Backend

```bash
cd server
npm install
npm run build
npm start
```

Listens on `127.0.0.1:8787`, loopback only. Configuration is read from `server/.env`, which is gitignored and must be created by hand:

| var                   | required                                | meaning                                                                                                             |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `NUNTIUS_DOMAIN`      | yes                                     | SIWS binding domain, a bare host such as `ochinimus.app`. Signed messages must carry exactly this domain.           |
| `HELIUS_RPC`          | for the Seeker gate and all chain reads | Mainnet RPC URL including the API key. Without it `/api/verify-seeker` answers 503 and everything else still works. |
| `PORT`                | no                                      | Defaults to `8787`.                                                                                                 |
| `FCM_SERVICE_ACCOUNT` | for push                                | Path to a Firebase service-account JSON. Must be set together with `FCM_PROJECT_ID`.                                |
| `FCM_PROJECT_ID`      | for push                                | Firebase project id.                                                                                                |

Endpoint semantics, including why each one fails closed, are in [`server/README.md`](server/README.md).

### App

Requires a real Android device — Mobile Wallet Adapter needs Kotlin native modules, so **Expo Go will not work**. A custom dev build is mandatory.

```bash
npm install
npx expo prebuild -p android
cd android && ANDROID_HOME=/path/to/android-sdk ./gradlew app:assembleDebug --no-daemon -PreactNativeArchitectures=arm64-v8a
cd .. && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8787 tcp:8787   # device reaches the backend
adb reverse tcp:8081 tcp:8081   # device reaches Metro
npm run dev
```

Both `adb reverse` mappings are lost on every reinstall and on reconnect — re-run them after each `adb install`, or the app reports a useless "Failed to connect to localhost:8081".

A **release** build cannot reach a local dev backend, because release blocks cleartext HTTP. That is a dev-only constraint (production is HTTPS), but device tests that need the backend must use the debug build.

---

## Security posture

- No secrets in the repository, and none in its history — `.env`, keystores, Firebase service accounts, `google-services.json` and the delegatee key are all gitignored, and the full object history was scanned for both secret-shaped paths and the exact live secret values before this repo was made public.
- The Helius API key never enters the app bundle. The app reaches the chain through an allowlisted server proxy that forwards only `getBalance`, `getVersion`, `getGenesisHash` and `getLatestBlockhash`; batches and every other method are rejected.
- SIWS nonces are crypto-random, five-minute, and consumed **atomically** — genuinely single-use, not best-effort.
- Push tokens are session-gated: a token binds to the verified session's own wallet address, never to a client-supplied one.
- Dependencies are pinned to exact versions in both `package.json` files.

---

## Prior work

**Disclosure, as the Colosseum rules require.**

This repository was created on **9 September 2026**. All 41 commits that existed before this line was written are dated **9–10 September 2026**, which **predates the Crypto World's Fair submission window that opened on 14 September 2026**. That work was done for the Solana Mobile × RadiantsDAO _Clock In_ hackathon, whose window opened on 8 September 2026, and it is disclosed here rather than presented as in-window work.

Everything in this repository was written from scratch for these two events. **No code was reused** from any earlier project. The commit history is complete and unrewritten; `git log` is the record.

The one vendored third-party component is `.agents/skills/solana-dev`, the Solana Foundation's published development skill, included under its own MIT licence and pinned by hash in `skills-lock.json`.

---

## Licence

MIT — see [LICENSE](LICENSE).
