# nuntius — build bible

One app, two hackathons. Everything binding is in this file.

Repo: `/Volumes/D/nuntius` · Package: `app.ochinimus.nuntius` · Scheme: `nuntius`
Started 2026-09-08. Fresh repo, no prior code, no reuse.

---

## 1. What it is

A Seeker-native alert app.

- **Push** is the delivery mechanism.
- **A measurement nobody else computes** is the payload.
- **Verified Seeker ownership** is the gate.
- **SKR staking** is the paid tier.

Working one-liner, keep sharpening it:

> Every Solana app tells you what happened after you open it. nuntius wakes the phone before you know to look.

---

## 2. The two clocks

| | Clock In (Solana Mobile x RadiantsDAO) | Crypto World's Fair (Colosseum) |
|---|---|---|
| Window | Sep 8 to **Oct 9 2026, 09:59 EEST** | Sep 14 to Oct 12 2026 |
| Prize | $135,000 USDC. 1st $30,000 + Seeker, 2nd $25,000, 3rd $20,000, 4th $15,000, 5th $10,000, 6th-10th $5,000, plus **$10,000 SKR bonus** | Solana track $100,000 across top 10, general pool top 21 across chains |
| Entry | Registered solo, `ochinimus` | Registered |
| Results | Nov 10 or 11 (their two pages disagree) | TBA |

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

- Push *is* the stickiness mechanism, which is Clock In criterion 1
- The measurement *is* the insight and the moat, which is Colosseum insight + founder fit
- The subscription *is* the viability answer

**Judges:** Toly, Mert (Helius CEO), Chase (Solana Foundation), Akshay and Beeman (Solana Mobile), Voynich and a2nkf/Ilias (both security researchers, Ethelsec).

---

## 4. Why this shape (measured 2026-09-08)

Colosseum Frontier product directory, filtered live. One field, 2,857 submissions.

| Category | Submissions | Winners + HMs | Rate |
|---|---|---|---|
| Data & Analytics | 61 | 2 | **3.3%** |
| Consumer Apps | 438 | 8 | 1.8% |
| Security Tools | 80 | 1 | 1.25% |
| AI Platforms / Agents | 493 | 4 | 0.8% |
| Wallet Infrastructure | 48 | 0 | 0% |

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

## 8. OPEN - what it alerts on

**Not chosen.** This is the whole product. It does not get picked on instinct.

Candidates:

- (a) realisable-exit gap on Solana lending collateral. Needs a ruling - `overhang` is blacklisted as a project, the thesis is not.
- (b) realized-vs-advertised APY drift on vaults the user actually holds - the shape YieldCompass already won with
- (c) unlock and vesting cliffs on tokens held in the user's own wallet
- (d) machine-payment / agent-spend anomalies
- (e) wallet-scoped: something about what you hold, computed before anyone else knows

Selection rule: if the measurement will not carry the headline, change the measurement.

Tool for settling it: **Colosseum Copilot**, installed globally and symlinked. 5,400 hackathon projects, 84,000 archive documents across 65 curated sources, 6,300 crypto products, Full/Partial/False gap classification, evidence floors. Deep Dive triggers on "vet this idea", "should I build X?", "deep dive".

**Status: their API returned 502 twice on 2026-09-09, an hour apart, fresh token, different shells. 502 is absent from their own troubleshooting list (400/401/413/429) and sits upstream of auth, so it is their gateway. Nothing to fix locally. Retry:**

```
curl "$COLOSSEUM_COPILOT_API_BASE/status" -H "Authorization: Bearer $COLOSSEUM_COPILOT_PAT"
```

Expected good response: `{"authenticated": true, "expiresAt": "...", "scope": "..."}`. Env vars are shell-session only unless persisted in `~/.zshrc`.

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

Spine first. The measurement drops into a slot that is already built.

1. ~~Fresh repo, RN Expo skeleton, first commit~~ **DONE**
2. MWA connect + SIWS with a real backend-issued single-use nonce
3. SGT verification end to end, uniqueness keyed on mint address
4. FCM push delivering a hardcoded test alert to a real device
5. Rule engine + evidence screen + daily digest
6. Drop the chosen measurement into the slot
7. SKR stake check to tier gate
8. Widget, polish, UX pass
9. Demo video under 3 min, deck, Colosseum pitch video 2-3 min + product demo video under 3 min, GTM and demand validation
10. AI Coach, fix what it flags, submit both

---

## 11. Build state as of 2026-09-09

- Repo scaffolded at `/Volumes/D/nuntius`. Two commits: `0d85185 chore: initial commit`, `df89ebd chore: set package app.ochinimus.nuntius and scheme nuntius`.
- `app.json` corrected off the placeholders: package `app.ochinimus.nuntius`, scheme `nuntius`. Done before Firebase, because Firebase keys its config to the package name.
- **Debug APK built and installed on the real Seeker, device `SM02E4060327059`. App runs, Metro connects. Verified on hardware, not assumed.**
- `.gitignore` excludes `android/`, `.gradle/`, `*.keystore`, `.env`, `.env.*`, `google-services.json`.
- `adb reverse tcp:8787 tcp:8787` set, so the Seeker reaches a Mac dev server at `http://localhost:8787`.
- **Claude Code Step 0 finding: the template's sign-in passes no nonce at all.** No replay protection whatsoever, so step 2 is a genuine build rather than a patch.

### Build environment

- Android SDK at `/Volumes/D/Android-sdk`, `ANDROID_HOME` set. Platforms 34-36.1, build-tools through 37.0.0. No Android Studio, no cmdline-tools, no emulator image - none needed, the Seeker is the target.
- Zulu JDK 17. Mac has 8GB RAM, so quit Brave before building.
- `gradle.properties` at `-Xmx2048m`, untouched so far.

### Rebuild after any native change

```
cd /Volumes/D/nuntius
npx expo prebuild -p android --clean
cd android && ./gradlew app:assembleDebug --no-daemon -PreactNativeArchitectures=arm64-v8a
cd /Volumes/D/nuntius && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

About 3 minutes. JS-only changes need no rebuild, Metro reloads them.

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
