# nuntius server

Auth backend: SIWS nonce issuance + verification, Seeker Genesis Token gate.

## Run

```
cd server
npm install
npm run build
npm start
```

Listens on `127.0.0.1:8787` (loopback only). **The Seeker reaches it through `adb reverse tcp:8787 tcp:8787`** — re-run that after the adb server restarts or the device reconnects. In production nginx fronts it on the VPS.

## Environment

Read from `server/.env` (gitignored — never commit it; create it by hand, it holds a key):

| var              | required                 | meaning                                                                                                    |
| ---------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `NUNTIUS_DOMAIN` | yes                      | SIWS binding domain, bare host (e.g. `ochinimus.app`). Signed messages must carry exactly this domain.     |
| `HELIUS_RPC`     | for `/api/verify-seeker` | Helius mainnet RPC URL including the API key. Without it that endpoint answers 503; everything else works. |
| `PORT`           | no                       | Defaults to `8787`, the port `adb reverse` maps.                                                           |

## Endpoints

- `GET /api/siws-payload` — issues a SIWS payload with a single-use nonce (crypto-random, 5-minute expiry). The payload is stored server-side keyed by nonce; verification only ever reads that stored copy.
- `POST /api/siws-verify` — body `{ nonce, signInResult }` where `signInResult` is the MWA `sign_in_result` (base64 `address`, `signed_message`, `signature`). Checks, failing closed and in order: (1) nonce issued-unexpired-unused, consumed atomically; (2) signature via `verifySignIn` from `@solana/wallet-standard-util`, with the message's address line bound to the verifying key; (3) domain binding against `NUNTIUS_DOMAIN`. Returns `{ address, session }`.
- `POST /api/verify-seeker` — body `{ session }`. Address comes from the verified session, never from the client. Queries Helius `getTokenAccountsByOwnerV2` (Token-2022) and verifies a candidate mint's authority, metadata pointer and group membership per the documented SGT check. Returns `{ sgtMint }` or `{ sgtMint: null }`. **An SGT moves between a user's own Seed Vault accounts when the primary account changes (mint address constant), so uniqueness is keyed on the mint address, never the wallet** — claiming a mint releases it from every other session, so one physical Seeker counts once whichever account holds it.

## Testing without a device

`node dist/selftest.js sign payload.json [--domain evil.example]` acts as a stand-in wallet: ephemeral ed25519 key, same SIWS message format, prints the `/api/siws-verify` body for curl. See repo history for the proof transcript.

`node --env-file-if-exists=.env dist/sgt-check.js <wallet>` runs the same SGT check the endpoint uses and prints the evidence: every Token-2022 account with its balance, the per-check classification of each candidate mint (mint authority, metadata pointer, group member), and the raw `jsonParsed` shape of any near-miss — so "no SGT held" and "parser failed to classify" are distinguishable. Never prints the RPC URL.

## Open items

- **`https://ochinimus.app/favicon.ico` must be hosted.** The app identity sets `icon: 'favicon.ico'` (relative to `uri`). Verified on device 2026-09-09: Seed Vault Wallet accepts the relative path and authorizes, but the file currently 404s so the wallet shows a **"?" placeholder** instead of an icon. A `data:` URI is **not** an alternative — Seed Vault rejects it outright with `-32602 "When specified, identity.icon must be a relative URI"` (the Kotlin client is stricter than the MWA spec). Hosting the favicon is therefore the only route to a real icon; not required for authorization to succeed.
- **`https://ochinimus.app/.well-known/assetlinks.json` (404s today)** must carry the release keystore fingerprint before wallets will trust the MWA app identity `https://ochinimus.app` via the Digital Asset Links check. The fingerprint does not exist yet (no release keystore).
