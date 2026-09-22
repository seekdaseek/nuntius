# nuntius — build bible

One app, two hackathons. Everything binding is in this file.

Repo: `/Volumes/D/nuntius` · Package: `app.ochinimus.nuntius` · Scheme: `nuntius`
Started 2026-09-08. Fresh repo, no prior code, no reuse.

---

## 1. What it is

A Seeker-native alert app.

- **Push** is the delivery mechanism.
- **A capped, revocable recurring delegation that executes while the app is closed** is the payload (section 8).
- **Verified Seeker ownership** is the gate.
- **SKR staking** is the paid tier.

Working one-liner, keep sharpening it:

> Every Solana app tells you what happened after you open it. nuntius wakes the phone before you know to look.

---

## 2. The two clocks

|         | Clock In (Solana Mobile x RadiantsDAO)                                                                                               | Crypto World's Fair (Colosseum)                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Window  | Sep 8 to **Oct 9 2026, 09:59 EEST**                                                                                                  | Sep 14 to Oct 12 2026                                                  |
| Prize   | $135,000 USDC. 1st $30,000 + Seeker, 2nd $25,000, 3rd $20,000, 4th $15,000, 5th $10,000, 6th-10th $5,000, plus **$10,000 SKR bonus** | Solana track $100,000 across top 10, general pool top 21 across chains |
| Entry   | Registered solo, `ochinimus`                                                                                                         | Registered                                                             |
| Results | Nov 10 or 11 (their two pages disagree)                                                                                              | TBA                                                                    |

Dual entry is explicitly permitted by Clock In's own FAQ. One build, two submissions.

---

## 3. Scoring - design against these, not against taste

**Clock In - four equal 25% criteria**

1. Stickiness & PMF - does it create habits and drive daily engagement
2. User Experience - intuitive, polished, enjoyable
3. Innovation / X-factor - novel, stands out
4. Presentation & Demo Quality

Also weighed: technical depth **via GitHub commits**, use of mobile features, meaningful Solana interaction, clarity of vision.

**Colosseum - seven factors**

founder+market fit, insight, product+execution, market size, founder communication, viability, traction.

It is a startup competition, not an engineering one.

**How this design resolves the conflict between them**

- Push _is_ the stickiness mechanism, which is Clock In criterion 1
- The capped delegation _is_ the insight and the moat, which is Colosseum insight + founder fit
- The subscription _is_ the viability answer

**Judges:** Toly, Mert (Helius CEO), Chase (Solana Foundation), Akshay and Beeman (Solana Mobile), Voynich and a2nkf/Ilias (both security researchers, Ethelsec).

---

## 4. Why this shape (measured 2026-09-08)

Colosseum Frontier product directory, filtered live. One field, 2,857 submissions.

| Category              | Submissions | Winners + HMs | Rate     |
| --------------------- | ----------- | ------------- | -------- |
| Data & Analytics      | 61          | 2             | **3.3%** |
| Consumer Apps         | 438         | 8             | 1.8%     |
| Security Tools        | 80          | 1             | 1.25%    |
| AI Platforms / Agents | 493         | 4             | 0.8%     |
| Wallet Infrastructure | 48          | 0             | 0%       |

The two Data & Analytics winners: **Flovia** (analytics for machine-paid APIs) and **YieldCompass** (realized APY + per-protocol risk scoring).

Push is absent from all 25 winners across both prior Solana Mobile hackathons.

**Not verified:** what is currently listed on the dApp Store. No public web catalogue exists. Do not claim "no push app exists" - only the winner-field claim is proven.

**Killed on the way here:** an MWA transaction firewall. There is no interception point in Mobile Wallet Adapter; to inspect before signing you must be the wallet. Category data agrees - Security Tools 1/80, Wallet Infrastructure 0/48, and the lane already holds Vigil, SolGuard, SolPolice, Killswitch, BlinkGuard, SentinelBag and Guardian Wallet Firewall.

**Parked:** an on-device x402 paying agent. Worst-converting Colosseum category and near-zero stickiness. Good idea, wrong competition.

---

## 5. The Seeker primitives

### Seeker Genesis Token (SGT)

An NFT minted once per device. Proof of verified Seeker ownership.

Verification flow:

1. Backend issues a single-use, short-lived SIWS nonce. Store it server-side keyed by nonce.
2. Client signs via MWA. `useMobileWallet` from `@wallet-ui/react-native-kit` exposes `signIn` directly.
3. Backend verifies with `verifySignIn` from `@solana/wallet-standard-util`. Check three things: the nonce is one you issued and is unused and unexpired, the signature is valid, the payload domain is your domain.
4. Check the verified wallet holds an SGT. Documented query path is Helius `getTokenAccountsByOwnerV2`.

**SGT transfers are narrow, not free-floating** (docs, verified 2026-09-09): the SGT can only move between a user's own wallet accounts within the Seed Vault Wallet, on a permissioned basis — a transfer happens when the user changes their primary account. The mint address stays the same across transfers. It is minted into the **primary account** of the Seed Vault Wallet. Uniqueness must still key on the **SGT mint address**, never the wallet.

`Platform.constants.Model === "Seeker"` is spoofable. Fine for UI treatment, never for gating.

### .skr domain

Human-readable name mapped to a wallet. Use it as the public leaderboard identity.

---

## 6. Architecture

- **App** - React Native Expo, scaffolded with `create-solana-dapp@4.8.5`, group Solana Mobile, template `kit-expo-minimal`. Expo SDK 55, RN 0.83.6, `@wallet-ui/react-native-kit@4.0.1`, `@solana/kit@6.1.0`, expo-router, TanStack Query.
- **Backend** - Node on the VPS, PM2 + nginx + Cloudflare tunnel. Local dev on port 8787.
- **Push** - Firebase FCM, per-rule Android notification channels so importance is user-controlled.
- **Data** - Helius RPC + webhooks.
- **Store** - SQLite for rules, subscriptions, fired events.

Deploy rule: edit and verify in sandbox, scp to VPS, `pm2 delete X && pm2 start ...`, `pm2 save`. Never `pm2 restart` for dotenv apps.

**Mobile features to actually use** (this is a scored axis): FCM notification channels, home-screen widget showing current state, background evaluation, biometric unlock on the paid tier.

**Solana interaction**: SIWS auth, SGT ownership read, SKR stake check for tier, on-chain reads as the alert source, optional memo write on acknowledge.

### Gates that bite if missed

- MWA uses Kotlin native modules, so it needs a custom dev build via `expo run:android`. **Never Expo Go.**
- `polyfill.js` calling `install()` from react-native-quick-crypto must be imported before any Solana library, via an `index.js` entry with package.json `main` pointing at `./index.js`.
- **`createSolanaMainnet` requires an explicit url** - there is no default public mainnet endpoint. This is why the Helius key is load-bearing, not cosmetic.
- **AppIdentity `uri` must be absolute** and wallets verify the app by checking Digital Asset Links at `/.well-known/assetlinks.json` on that domain against the APK signing key. The MWA spec recommends declining authorization when identity carries no uri.
- **The `icon` must be a path relative to `uri` or a `data:` URI.** An absolute http(s) icon may be rejected, and the Kotlin client accepts only the relative path.
- ochinimus.app owes an `assetlinks.json` carrying the fingerprint of whatever keystore signs the APK.

---

## 7. Stickiness mechanics

25% of the Clock In score. Design these deliberately, do not hope for them.

- Daily digest push at a user-set time, so the app has a reason to open on days nothing fires.
- Streak counter on consecutive acknowledged days. Public leaderboard keyed to `.skr` name, SGT-gated so one device is one entry.
- Every alert taps through to an evidence screen: what was measured, when, and the Solscan link. Never a bare number.
- Two tiers: free for anyone with a wallet, full product for verified Seeker owners. SGT-only would ace Clock In's Seeker-resonance criterion and gut Colosseum's market-size factor.

---

## 8. DECIDED - what it moves

**A capped, revocable, recurring on-chain payment authority, granted once in Seed Vault.** Decided 2026-09-10 (BRIEF-05). This **supersedes the realisable-exit-gap measurement payload**, which is dead and must not be built. Sections 1 and 7 still hold unchanged: push is the delivery, verified Seeker ownership is the gate, SKR staking is the paid tier. Only the payload changed.

The app no longer computes a number and tells you about it. **It moves money on terms the user set once, and the push is the receipt.**

### What it does

The user sets a rule once. Seed Vault approves a delegation once. After that it executes on a schedule - a recurring deposit into yield, a scheduled buy, a capped allowance a merchant or an agent may draw against. Push fires on every execution and taps through to the evidence screen: moved, remaining, reset, Explorer link. The cap resets each period. Revocation is one transaction.

The one-liner in section 1 survives the pivot verbatim: _every Solana app tells you what happened after you open it; nuntius acts on days you never open it._

### The primitive it is built on

**Solana Subscriptions & Allowances** - the Subscriptions Delegation Program. Native, open source, audited by Cantina, built by Moonsong Labs with the Solana Foundation, announced 2 June 2026.

```
Program ID   De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44
Docs         https://solana.com/docs/payments/subscriptions/overview
Repo         solana-foundation/subscriptions
SDK          @solana/subscriptions 0.5.0 (kit-native, peer @solana/kit ^7)
```

Same canonical address on devnet and mainnet - verified live, no per-cluster switching. The program account is **upgradeable**; upgrade authority `DXtFpbPjcn2hxPnw79x1Pfoj35vXh5AsWBkS37YnXMVv` as measured 2026-09-22. That is a real dependency risk and is the reason the per-period cap, not trust, is what bounds exposure.

Why the program exists at all, in the Foundation's words: a Solana token account can hold **only one** approved authority at a time, which makes it impossible for one wallet to safely carry several spending arrangements for the same token. The program gives each `(user, mint)` pair a program-controlled **Subscription Authority**. The token account approves that authority once; the program then checks every requested transfer against a separate record defining who may pull, how much, and when it resets or expires. **The Subscription Authority cannot move funds by itself.**

Three models ship - fixed delegation, recurring delegation, subscription plan. **nuntius uses recurring.**

### Why the cap is the product, not a feature

The mechanism is only sellable because the blast radius is bounded **by the chain**, not by our code:

- An over-cap pull is rejected by the program: `custom program error: 0x190` = `amountExceedsPeriodLimit`. Proven on devnet (section 11), not asserted.
- `revokeDelegation` then `revokeSubscriptionAuthority` leaves `userAta delegate: none` and kills further pulls. **Never `closeSubscriptionAuthority`** - it leaves the SPL delegate live and reports a false pass.
- The user signs once, at authorization. Every later pull is signed by the delegatee alone. That is the whole point, and it is also exactly what makes the cap load-bearing.

### Why this one survives the corpus

The corpus work behind the retired measurement still binds the product, because it was never about which number to compute - it was about what does **not** differentiate:

- Top two problem tags across Cypherpunk + Breakout are **"information overload" (47)** and **"information asymmetry" (32)**. The corpus agrees on the problem and attacks it with dashboards.
- Consumer Apps is the most crowded track that exists (1,090 Cypherpunk + 923 Breakout submissions).
- Every alerting _winner_ sold infrastructure: `tokamai` (2nd Infra, $20k, accelerator C2), `conyr` (5th Infra), `ionic` (3rd Infra). Every consumer push attempt failed to place: `nova`, `notifease`, `solsignal.xyz`, `basin-1`.
- **The differentiator cannot be that you send a push.** Dialect commoditized generic transaction and balance alerts, so any payload already visible in a wallet is dead on arrival.

A measurement is still a notification, and notifications are the commoditized layer. A **capped delegation that executes while the app is closed** is not a notification - it is an action the user authorized and can revoke, and the push is merely its receipt. That is the differentiator the corpus says is required.

### Why it fits both clocks

- **Clock In** - Seed Vault is the mechanism, not decoration. The app acts on days the user never opens it, which satisfies the stickiness criterion structurally rather than by hoping for engagement. First mobile use of a primitive Solana shipped in June 2026.
- **Colosseum** - payments infrastructure with a consumer face, on an audited program, so there is no unaudited-code risk to defend. Fee-on-flow business model, already validated at 0.25% by Solana Mobile's own Earn Vault.

Both descriptions are true of the same repo with no repositioning.

### Tool that settled the pivot

**Colosseum Copilot**, installed globally and symlinked. 5,400 hackathon projects, 84,000 archive documents, 6,300 crypto products, Full/Partial/False gap classification, evidence floors. Deep Dive triggers on "vet this idea", "should I build X?", "deep dive".

**`source ~/.zshrc` first, every time.** Each non-interactive shell starts without `COLOSSEUM_COPILOT_API_BASE` / `COLOSSEUM_COPILOT_PAT` even though they are in `~/.zshrc` (lines 20-23, duplicated). Without it curl fails with "No host part in the URL".

```
source ~/.zshrc && curl "$COLOSSEUM_COPILOT_API_BASE/status" -H "Authorization: Bearer $COLOSSEUM_COPILOT_PAT"
```

**Build state for this payload is section 11.** Do not restate it here - that split is what produced the contradiction this section was rewritten to remove.

---

## 9. Rules that bind

- **One submission each side.** Clock In: multiple entries are an automatic forfeit. Colosseum: one product per builder.
- **Fresh repo.** The Clock In form gates on "Has your project been built in the last 3 months? YES/NO". The answer must be a clean yes.
- **No code reuse at all.** Nothing from LineWatch, SolWatch or the collectors enters this repo. Consequence: the Colosseum pre-existing-code disclosure is a plain "none". Patterns and lessons port freely, only code is barred.
- **The repo goes in front of two security researchers** and through the terminal's SECURITY AUDIT app. No secrets in the repo, no committed `.env`, dependencies pinned, the SIWS nonce store genuinely single-use.
- **Commits are a judged surface.** Steady in-window history, not one dump before the wall.
- **Run the AI Coach** inside the Clock In submission form before submitting.
- Shortlisted Colosseum teams get a 15-minute Zoom interview.

---

## 10. Build order

Spine first. The payload drops into a slot that is already built.

1. ~~Fresh repo, RN Expo skeleton, first commit~~ **DONE**
2. MWA connect + SIWS with a real backend-issued single-use nonce
3. SGT verification end to end, uniqueness keyed on mint address
4. FCM push delivering a hardcoded test alert to a real device
5. Rule engine + evidence screen + daily digest
6. Drop the delegation payload into the slot (BRIEF-05, BRIEF-06)
7. SKR stake check to tier gate
8. Widget, polish, UX pass
9. Demo video under 3 min, deck, Colosseum pitch video 2-3 min + product demo video under 3 min, GTM and demand validation
10. AI Coach, fix what it flags, submit both

---

## 11. Build state as of 2026-09-10

**Proven on the real Seeker `SM02E4060327059`** (briefs 01-04):

- SIWS with a backend-issued single-use nonce; replay, expiry and domain binding all rejected. Seed Vault signs the payload field-for-field - it adds no `Version:` or `Chain ID:` line, so `verifySignIn` passes with no loosening.
- SGT gate returns mint `Gv9AN58bVkqWp4w7dNc7nT3cJAavAH1VBi4fpESsCVZn` for the device wallet; `claimSgtMint` writes it through a real session.
- Allowlisted mainnet RPC proxy (`/api/rpc`) - the Helius key never enters the bundle.
- FCM push arriving in **all three states**: foreground, backgrounded, and killed via `am kill`. Warm tap-through routes to the alert screen.
- **MWA cancel bug fixed (`66ab4e8`)** - the kit replayed a cached `auth_token` and never cleared it, bricking every later sign-in. Now authorizes fresh via low-level `transact`. Proven: cancel -> retry -> succeed 3x with no restart, and cancel -> background -> foreground -> retry -> succeed.

- **Release-build cold-start tap-through CLOSED.** From a 0-process release build, a push tap cold-launches straight to the alert screen with the right payload, splash intact. The earlier failure was **our bug, not the documented debug-splash issue**: a cold launch delivers the notification response before expo-router mounts its root navigator and the `router.push()` was silently dropped. Fixed in `b0e35c3` by gating on `useRootNavigationState().key`.

### Delegation spike (BRIEF-05, 2026-09-10)

The measurement payload is dead; the payload is now **Solana Subscriptions** recurring delegations. `@solana/subscriptions@0.5.0` is kit-native (peer `@solana/kit ^7`), ships CJS + ESM, and audits clean. Program `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44` is deployed at the **same canonical address on devnet and mainnet** - verified live, no per-cluster switching.

**Proven on devnet** (all seven spike items, real signatures in git history):

- Over-cap pull is rejected by the chain: `custom program error: 0x190` = **`amountExceedsPeriodLimit`**. Enforcement is the program's, not ours.
- After `revokeDelegation` the delegation account ceases to exist and a pull dies with `Invalid account owner`; `revokeSubscriptionAuthority` then leaves `userAta delegate: none`. **Never use `closeSubscriptionAuthority`** - it leaves the SPL delegate live and would give a false pass.
- Pull -> FCM push -> tap -> evidence screen showing moved / remaining / reset / Explorer link, proven on the device.

**~~BLOCKED~~ - RESOLVED ON MAINNET 2026-09-22 (BRIEF-06).** The devnet block was never a code fault: Seed Vault refused a devnet delegation because the **wallet app's own network** is mainnet - _"Network mismatch - your current network is set to mainnet, but this transaction is for devnet."_ It had parsed the transaction correctly. Moving to mainnet removes the mismatch, and **Seed Vault signs.** See section 11a.

**Executor:** a single in-process timer (`server/src/executor.ts`). Production needs are documented in that file rather than half-built - durability, leader election, delegatee fee funding, KMS custody, lazy-period-aware scheduling, observability.

- Repo scaffolded at `/Volumes/D/nuntius`. Two commits: `0d85185 chore: initial commit`, `df89ebd chore: set package app.ochinimus.nuntius and scheme nuntius`.
- `app.json` corrected off the placeholders: package `app.ochinimus.nuntius`, scheme `nuntius`. Done before Firebase, because Firebase keys its config to the package name.
- **Debug APK built and installed on the real Seeker, device `SM02E4060327059`. App runs, Metro connects. Verified on hardware, not assumed.**
- `.gitignore` excludes `android/`, `.gradle/`, `*.keystore`, `.env`, `.env.*`, `google-services.json`.
- `adb reverse tcp:8787 tcp:8787` set, so the Seeker reaches a Mac dev server at `http://localhost:8787`. **The reverses are lost on reinstall and on reconnect** - `adb reverse --list` came back empty twice mid-session and the symptom is a useless "Failed to connect to localhost:8081". Re-run both (8787 and 8081) after every `adb install`.
- **A release build cannot reach the local dev backend**: release blocks cleartext HTTP, so `http://localhost:8787` fails and the app shows `Version: undefined`. Dev-only - production is HTTPS - but device tests that need the backend must use the debug build.
- **Claude Code Step 0 finding: the template's sign-in passes no nonce at all.** No replay protection whatsoever, so step 2 is a genuine build rather than a patch.

### 11a. Mainnet proof, 2026-09-22 (BRIEF-06)

**The product exists.** The full life cycle ran on mainnet-beta with real USDC, signed by Seed Vault on device `SM02E4060327059`.

Payer/delegator was **natX** `ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX`, not the cj7 treasury. Destination was cj7's existing ATA `HqbmBbn...az5z`, which **was never delegated** - it stayed `delegate: none` throughout, confirmed in the init simulation's post-state before signing and in every reading after.

| step                        | signature                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| initSubscriptionAuthority   | `bBNbUgwhwFAmb8GM7L9AwJJjcn8UFCymrHaajLXS9R4uTTxvNUwKGVSNkj5A8EAmVuRW2PJBzjrBCuZUqGS2Sks`  |
| createRecurringDelegation   | `5r7YnGrbRCPb74W1t1p1xDzMtaTPL47orLsbGmpiMgAkmwbEfU9MKW7hGpZP4mcwv1cFLAXTq8pGWNsFUGinugMw` |
| transferRecurring x4        | `59Zn57sY...qtjJF` `5kSbpeH6...y1TXJ` `3utaq3gm...VN96W` `41emXYEH...82B5vy`               |
| over-cap (2x cap)           | `3RpcCkkLmwq5wT4moE1TQrXpnjRn36kWgmtRah9Y6kZuo3n5bVYdWTvnov4zQMXEr3vcS15pbE7jJENPmaZpWyR7` |
| cap exhausted in-period     | `5ryxPMPjNXzYCGtA9yQ6ZGG2enVmXjyN9PnotF9x1h7N9MqZjS5Kk9K1YQsh4661Hn7xNPhn1N6pcoQ1TKAjsDpd` |
| revokeDelegation            | `Vh2yr9VTe8YeqcGqffuVZEa26ZicoJP3FV5k8y4FYNXtECCEXu6bvbWZ6u8XuRXWP6XSp5hxUpq1X97TYmsb1wT`  |
| revokeSubscriptionAuthority | `2doDFNXUxvBcstNJJDwjWCyrEGMLEugQAUeXTth4eCJnsXHb3S89s17Jtr34Raxg25vwQF1MGTC5cMFjgVsij9Y8` |
| pull after revocation       | `cfESoUjxbXF341RwzBtqyuBMAZ7rwA6mhbJCqQ1fqs91Gc48eFd5yzqLfT2vnazxJwB2JL7WcuSqzEzTtM5GPzm`  |

- **The user signs nothing after authorizing.** Each `transferRecurring` has exactly ONE signer - the delegatee - and the delegator is absent from the signer set. Read from the recorded account keys, not asserted.
- **Over-cap rejection is the chain's.** `custom program error: 0x190` = `amountExceedsPeriodLimit`, recorded as `{"InstructionError":[0,{"Custom":400}]}`. Sent with `skipPreflight` deliberately, so the rejection is a **landed mainnet transaction** rather than a preflight refusal with nothing to point at.
- **Reset works.** After the 60 s window rolled, the same delegation allowed another pull, no new user signature.
- **Revocation is complete.** Both PDAs closed, `userAta delegate: none`, further pull dies `InvalidAccountOwner`.
- Cap 10,000 base units / 60 s. 17,000 base units moved across four pulls. natX ended 112,000 lamports down - both rents came back on revoke.

**The u64::MAX fact, which the cap does NOT bound.** `initSubscriptionAuthority` approves the authority PDA for `u64::MAX` at the SPL level (the Foundation's architecture doc labels the PDA exactly that). The per-period cap lives in the delegation record, not in the token approval. While an authority is live, the _entire_ balance of that token account is reachable if the program misbehaves - and the program is **upgradeable** (authority `DXtFpbPjcn2hxPnw79x1Pfoj35vXh5AsWBkS37YnXMVv`). Operational rule: delegate from an account holding near what the delegation needs, and revoke when done.

**Period choice.** The program's floor is 1 second (`period_length_s > 0`, max 365 days, from `create_recurring_delegation.rs`). 60 s was chosen because `transfer_validation.rs` advances the period **lazily on each transfer** and zeroes `amount_pulled_in_period` - so a 1 s period would let an over-cap attempt find a fresh budget and succeed, destroying the proof. 60 s keeps a pull and an immediate second attempt inside one window while still showing a reset live.

**Two bugs the mainnet cap exposed**, both invisible at the devnet 100-token cap:

- The push formatted base units with integer division, so a 5,000-base-unit draw at 6 decimals rendered as `0 tokens moved`.
- The evidence screen hardcoded `?cluster=devnet` on the Explorer link, pointing a mainnet user at the wrong chain.

**Repo is public:** `https://github.com/seekdaseek/nuntius`, MIT.

### Build environment

- Android SDK at `/Volumes/D/Android-sdk`. Platforms 34-36.1, build-tools through 37.0.0. No Android Studio, no cmdline-tools, no emulator image - none needed, the Seeker is the target.
- **`ANDROID_HOME` is NOT set in every shell.** A non-interactive shell often starts without it and Gradle then fails with `SDK location not found`. Prefix the build: `ANDROID_HOME=/Volumes/D/Android-sdk ./gradlew ...`.
- **`expo prebuild --clean` wipes `android/local.properties`**, which is where the SDK path would otherwise have been cached - so the two facts above bite together, right after a clean.
- Zulu JDK 17. Mac has 8GB RAM, so quit Brave before building.
- `gradle.properties` at `-Xmx2048m`, untouched so far.

### Rebuild after any native change

```
cd /Volumes/D/nuntius
npx expo prebuild -p android --clean
cd android && ./gradlew app:assembleDebug --no-daemon -PreactNativeArchitectures=arm64-v8a
cd /Volumes/D/nuntius && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**"About 3 minutes" is the INCREMENTAL figure.** A `--clean` full native rebuild on this 8GB machine takes considerably longer - measured 2026-09-09/10: the debug `--clean` rebuild ran past 10 minutes (537 tasks, 505 executed) and had to be backgrounded. Budget for that, and do not mistake the silence for a hang (see the Gradle lock trap below). A release build off an already-populated tree is fast by comparison: 911 tasks, only 28 executed.

Release variant, for anything notification-launch related:

```
cd /Volumes/D/nuntius/android && ANDROID_HOME=/Volumes/D/Android-sdk ./gradlew app:assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a
adb install -r /Volumes/D/nuntius/android/app/build/outputs/apk/release/app-release.apk
```

JS-only changes need no rebuild, Metro reloads them.

### The Gradle lock trap - cost 40 minutes on day one

**A first build takes many minutes and prints nothing through `tail`. That silence is not a hang. Ctrl-C is what creates the lock.**

Symptom: build fails in under a second with `Cannot lock file hash cache (android/.gradle/9.0.0/fileHashes) as it has already been locked by this process`.

Recovery:

```
pkill -9 -f GradleDaemon; pkill -9 -f KotlinCompileDaemon; pkill -9 -f gradle
ps aux | grep -i gradle | grep -v grep | wc -l     # must be 0
rm -rf android/.gradle ~/.gradle/daemon
```

Then rebuild with `--no-daemon`, which leaves no background process to hold a lock and also stops a leftover daemon squatting on memory.

---

## 12. Submission requirements

**Clock In** - functional Android APK that runs on a device, GitHub repo judges can read, demo video under 3 min, pitch deck. Must integrate Solana Mobile Stack and Mobile Wallet Adapter. Direct ports and PWA wrappers score poorly. dApp Store publishing is not required by the deadline; winners have 30 days after the announcement.

**Colosseum** - presentation video 2-3 min, product demo video under 3 min, GTM strategy and demand validation, repo access (private is allowed if `hackathon@colosseum.com` is granted access).

---

## 13. Surfaces owed on ship

Repo + README, APK, card on ochinimus.app, X post from @ochinimus, Clock In submission, Colosseum submission, dApp Store publish within 30 days if it wins.
