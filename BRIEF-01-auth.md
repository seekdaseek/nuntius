# BRIEF 01 — SIWS auth + Seeker Genesis Token gate

## SETUP — do this before anything else

**Working directory must be `/Volumes/D/nuntius`.** In Claude Code desktop, select that folder in the project picker. In the terminal, `cd /Volumes/D/nuntius` before launching. Nothing in this brief works from anywhere else.

**Prerequisites, already done — do not redo them:**

- Scaffold created with `create-solana-dapp@4.8.5`, template `kit-expo-minimal`
- Package name `app.ochinimus.nuntius`, scheme `nuntius`, both already set in `app.json`
- Debug APK built and installed on a real Seeker, device id `SM02E4060327059`
- `adb reverse tcp:8787 tcp:8787` is set, so the Seeker can reach a Mac dev server at `http://localhost:8787`
- `.gitignore` already excludes `android/`, `.gradle/`, `*.keystore`, `.env`, `.env.*`, `google-services.json`

**If `adb reverse` needs re-running** (it resets when the adb server restarts or the device reconnects):

```
adb reverse tcp:8787 tcp:8787
```

**Rebuild after any native change** (anything touching `app.json`, plugins, or native deps):

```
cd /Volumes/D/nuntius
npx expo prebuild -p android --clean
cd android && ./gradlew app:assembleDebug --no-daemon -PreactNativeArchitectures=arm64-v8a
cd /Volumes/D/nuntius && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Takes about 3 minutes. Use `--no-daemon` — a killed Gradle daemon leaves a lock in `android/.gradle` that makes every later build fail in under a second with `Cannot lock file hash cache`. If that happens: `pkill -9 -f gradle; rm -rf android/.gradle`.

JS-only changes need no rebuild — Metro reloads them.

---

## Context

Project: `nuntius` at `/Volumes/D/nuntius`
Package: `app.ochinimus.nuntius` · Scheme: `nuntius`
Stack as scaffolded: Expo SDK 55, React Native 0.83.6, `@wallet-ui/react-native-kit@4.0.1`, `@solana/kit@6.1.0`, expo-router, TanStack Query.

Read `BIBLE.md` in this repo before starting. It has the scoring rubrics this code is judged against.

---

## Goal of this brief

Turn the scaffold's demo sign-in into a real, replay-resistant Seeker identity gate:

1. Sign in with Solana (SIWS) through Mobile Wallet Adapter, with a **backend-issued, single-use, short-lived nonce**.
2. Server-side verification of the signature, the nonce, and the domain.
3. Seeker Genesis Token ownership check, keyed on the **SGT mint address**.
4. Two tiers surfaced in the UI: connected wallet (basic) vs verified Seeker owner (full).

Nothing else. No alert logic, no push, no rule engine in this brief.

---

## Step 0 — inspect before changing

The template ships these already:

```
features/account/account-feature-sign-in.tsx
features/account/account-feature-connect.tsx
features/account/account-feature-sign-message.tsx
features/account/account-feature-index.tsx
components/app-providers.tsx
constants/app-config.ts
```

Read `account-feature-sign-in.tsx` and `app-providers.tsx` first and report what the existing sign-in actually does before rewriting it.

**Specifically: find where the SIWS payload comes from.** If the nonce is generated on the client, that is the thing being replaced. Solana Mobile's docs are explicit that the nonce must be backend-issued, single-use and short-lived, because without it a captured `signInResult` can be replayed to authenticate forever.

Do not assume. Read it, say what it does, then change it.

---

## Step 1 — backend

New directory `server/` in this repo. Node, Express, TypeScript. Runs locally during development on port 8787, which is the port `adb reverse` is already mapping (see SETUP). Document that requirement in `server/README.md`.

Storage: SQLite. One file, `server/nuntius.db`. Tables for issued nonces and verified sessions. Do not invent additional tables in this brief.

### `GET /api/siws-payload`

Returns a SIWS payload. Requirements:

- `nonce`: cryptographically random, from `crypto.randomBytes`
- `issuedAt`, `expirationTime`: expiry no longer than 10 minutes
- `domain` and `uri`: read from config, never from the request
- The issued payload is **stored server-side keyed by nonce**. Verification loads it from that store, never from a client-supplied copy.

### `POST /api/siws-verify`

Body: `{ nonce, signInResult }`.

Verification must check three things, in this order, and fail closed on any of them:

1. The nonce is one this server issued, has not expired, and **has not been used before**. Consuming it must be atomic — mark used and return the payload in one operation, returning null if unknown, expired or already used.
2. The signature is valid for the issued payload. Use `verifySignIn` from `@solana/wallet-standard-util`.
3. The payload's `domain` matches this server's expected domain. A signature obtained by a different dApp must not verify here.

Validate the shape of `signInResult` before consuming the nonce — a wallet that does not support SIWS omits `sign_in_result`, and a malformed request must not burn a valid nonce.

The MWA `sign_in_result` carries base64 `address`, `signed_message` and `signature`. Convert to the `SolanaSignInOutput` shape `verifySignIn` expects. The public key must be 32 bytes; reject otherwise.

On success, return the verified wallet address.

### `POST /api/verify-seeker`

Runs after SIWS verification succeeds. Checks whether the verified wallet holds a Seeker Genesis Token.

- Query Helius `getTokenAccountsByOwnerV2` using `HELIUS_RPC` from env.
- Return the **SGT mint address** if held, null otherwise.
- **SGTs are transferable between wallets. Uniqueness must be enforced on the mint address, not the wallet address.** Store the mint address so one physical device cannot be counted twice by moving the token.

Env vars, read from `server/.env`, which is gitignored: `HELIUS_RPC`, `NUNTIUS_DOMAIN`, `PORT`.

Never log a full token, signature or RPC URL.

---

## Step 2 — client

Use `useMobileWallet` from `@wallet-ui/react-native-kit`. It exposes `signIn` for SIWS directly — do not add the legacy `@solana-mobile/mobile-wallet-adapter-protocol-web3js` package.

Flow:

1. Fetch the payload from `GET /api/siws-payload`.
2. Call `signIn` with it via MWA.
3. POST `{ nonce, signInResult }` to `/api/siws-verify`.
4. On success, POST to `/api/verify-seeker`.
5. Store the resulting session and Seeker-verified flag in app state via TanStack Query.

### Identity object — this has a non-obvious constraint

Set in `MobileWalletProvider`:

- `name`: `nuntius`
- `uri`: an **absolute** URL on a domain we control — use `https://ochinimus.app`. The MWA spec recommends wallets decline authorization when identity carries no `uri`.
- `icon`: a **path relative to `uri`**, or a `data:` URI holding base64 SVG/WebP/PNG/GIF. **An absolute HTTP URL is neither and wallets may reject the authorization request.** The Kotlin client is stricter still and accepts only the relative path.

Wallets verify the app by checking the Digital Asset Links file on the `uri` domain against the app signing key. `ochinimus.app` will need `/.well-known/assetlinks.json` carrying the release keystore fingerprint. Not in this brief — note it in `server/README.md` as an open item.

### UI

Three states, visibly distinct:

- Disconnected — connect button
- Connected, not Seeker-verified — basic tier, with a clear path to verify
- Seeker-verified — full tier, showing that verification succeeded

Keep the template's existing styling conventions in `constants/app-styles.ts`. No new UI library.

---

## Step 3 — prove it

Nothing here counts as done until it has been run on the attached Seeker (`SM02E4060327059`) and the output observed. "Should work" is not a result.

Report, with actual output:

1. A successful SIWS sign-in against the real Seed Vault Wallet on the device.
2. The same `signInResult` replayed a second time to `/api/siws-verify` — **must be rejected**, because the nonce was consumed.
3. An expired nonce rejected.
4. A payload with a mismatched domain rejected.
5. The SGT check run against the real wallet on that Seeker, returning the mint address.

If any of these cannot be demonstrated, say so plainly and say what would demonstrate it. Do not report success on an untested path.

---

## Constraints

- **All code is fresh.** Nothing may be copied from other repos on this machine. This is a hard rule for both hackathons and it is declared on the submission form.
- Commit in small, meaningful steps. Commit history is a judged surface and is read by the judges.
- No secrets in the repo. `.env`, `google-services.json` and `*.keystore` are already gitignored.
- This repo will be read by two security researchers and passed through an automated audit tool. Pin dependencies, fail closed, no debug endpoints left behind.
- TypeScript must pass: `npm run build` runs `tsc --noEmit`.
