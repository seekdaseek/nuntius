# BRIEF 03 — the client (build order step 2)

Working directory: `/Volumes/D/nuntius`. Confirm the absolute path first.

Read `BIBLE.md`, then this. `BRIEF-01-auth.md` and `BRIEF-02-sgt-and-fixes.md` are done and are history now.

Backend state, proven: SIWS payload issuance, atomic single-use nonce, replay rejected, expiry rejected, domain binding both directions, and the SGT check verified against live Helius — wallet `4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7` holds SGT mint `Gv9AN58bVkqWp4w7dNc7nT3cJAavAH1VBi4fpESsCVZn`, member number 84827, parser needed no fix.

---

## 0. Two loose ends first

**0a.** The `--env-file-if-exists` fix is already in the tree. Nothing to commit. Confirmed, drop it.

**0b. Run prettier over the docs and commit.** `npm run ci` includes `format:check` and it is currently red on `BIBLE.md` because of hand-written table formatting. A red CI on a doc will hide a real failure later. Format the markdown files, commit as a formatting-only change, and confirm `npm run ci` passes clean.

---

## 1. The nonce problem, and the documented answer

You reported zero matches for `nonce` in the kit's dist. The Quickstart's `signIn` example passes only `{address, chainId, domain, statement, uri}` — no `nonce`, no `issuedAt`, no `expirationTime`.

**This must be established empirically before anything is built on it.** Call the kit's `signIn` with the full backend-issued payload including nonce, issuedAt and expirationTime, then inspect the `signedMessage` that comes back and report whether those three fields survived into the signed text.

- **If they survive** — use the kit's `signIn`. Simplest path, fewest dependencies.
- **If they are stripped** — the kit cannot carry a backend-issued nonce, and the whole replay-resistance design fails silently at the client boundary. Fall back to the low-level path, which is documented and explicitly supports it.

**The documented low-level path**, from `https://docs.solanamobile.com/get-started/react-native/invoke-mwa-sessions-directly`:

```
@solana-mobile/mobile-wallet-adapter-protocol
@solana-mobile/mobile-wallet-adapter-protocol-kit
```

Use the `-kit` wrapper. The docs call it "the preferred wrapper for new apps that use @solana/kit". **Do not use `-web3js`** — that is the legacy wrapper and drags in the dependency tree you already removed for its audit vulnerabilities.

```ts
const signInResult = await transact(async (wallet: KitMobileWallet) => {
  const authorizationResult = await wallet.authorize({
    chain: "solana:mainnet",
    identity: APP_IDENTITY,
    sign_in_payload: { /* the full payload from GET /api/siws-payload */ },
  })
  return authorizationResult.sign_in_result
})
```

`sign_in_payload` is a full `SolanaSignInInput`, so nonce, issuedAt and expirationTime pass through intact.

Solana Mobile's own guidance on that page, which is the design you already built:

> In production, generate the sign_in_payload on your backend with a single-use nonce, issuedAt, and expirationTime, then verify the result server-side — including that the payload's domain is yours and the nonce hasn't been used before.

Whichever path wins, report which and why. If you add the low-level packages, re-run `npm audit` and report the result — it must stay at 0.

---

## 2. AppIdentity

Currently `{ name: 'kit-expo' }` with no uri and no icon. Change to:

- `name`: `nuntius`
- `uri`: `https://ochinimus.app` — absolute. The MWA spec recommends wallets decline authorization when identity carries no uri.
- `icon`: **a path relative to `uri`**, e.g. `favicon.ico` resolving to `https://ochinimus.app/favicon.ico`.

⚠️ **Verified 2026-09-09: `https://ochinimus.app/favicon.ico` and `/favicon.png` both return 404.** The site's HTML declares them but the Cloudflare Worker does not serve them. So the relative-path icon currently points at nothing, and if the wallet fetches it, authorization may be declined for a reason that looks like a code bug.

Handle it this way:

1. Build with the relative path as the intended final answer. Hosting the file is the owner's task and is tracked separately.
2. **Additionally test a `data:` URI icon on the device** — the MWA spec accepts a `data:` URI holding base64 SVG, WebP, PNG or GIF. An absolute http(s) URL is neither and may be rejected.
3. Report what Seed Vault actually did with each: whether it showed an icon, showed a placeholder, or refused. That answer decides whether hosting the favicon is urgent or cosmetic.

Note in `server/README.md`, under open items: `https://ochinimus.app/.well-known/assetlinks.json` also 404s. Wallets verify the app by checking Digital Asset Links on the identity domain against the APK signing key. It needs the release keystore fingerprint, which does not exist yet.

---

## 3. Mainnet and the Helius key

The template ships devnet and testnet only. Mainnet is needed — the SGT lives there.

**The Helius key must never be in the app bundle.** An APK is trivially unpacked and the repo is read by security judges.

`createSolanaMainnet` requires an explicit url; there is no default public mainnet endpoint. Preferred approach: **add an RPC proxy route on the backend** and point the client's mainnet cluster at it, so exactly one process holds the key and we keep rate control. If you take a different approach, say which and why, and state explicitly where the key ends up.

If you build the proxy: allowlist the RPC methods the client actually needs, reject everything else, and do not forward arbitrary method names. An open proxy in front of a paid key is exactly what an audit flags.

Keep devnet available for development. The chain passed to `authorize` must match the cluster the app is actually using.

---

## 4. The sign-in flow

Replace the template's discard-the-result version:

1. `GET /api/siws-payload`
2. Sign it via the path chosen in section 1
3. `POST /api/siws-verify` with `{ nonce, signInResult }`
4. On success, `POST /api/verify-seeker` with the session
5. Persist the session and the Seeker-verified flag via TanStack Query

Two documented gotchas:

- **"Read the account from the returned result — the hook's `account` is not updated until the next render."** Do not read `account` immediately after `signIn`.
- `signIn` works whether or not the user is already connected. Omitting `address` lets the wallet pick the account in the same prompt — fewer taps, which matters because User Experience is 25% of the score.

Consider caching `auth_token` so return visits skip the approval dialog. This is a stickiness feature, not just convenience: the app is meant to be opened daily.

---

## 5. UI

Three visibly distinct states:

- **Disconnected** — connect / sign-in entry point
- **Connected, not Seeker-verified** — basic tier, with a clear path to verify
- **Seeker-verified** — full tier, showing verification succeeded

Keep `constants/app-styles.ts` conventions. No new UI library. Two of the four scoring criteria are User Experience and Presentation, so this should look deliberate rather than like a scaffold with extra buttons — but do not gold-plate it now, the real UX pass comes later in the build order.

---

## 6. Prove it on the device

`SM02E4060327059`, `adb reverse tcp:8787 tcp:8787` already set. Backend runs with `npm start` from `server/`.

Report, with actual output:

1. **Whether the nonce survived into the signed message** (section 1). This is the highest-risk unknown in the whole client.
2. **Whether Seed Vault's signed message verifies against `verifySignIn` field for field.** You flagged that `verifySignIn` is strict and rejects if the wallet emits lines the payload does not carry — for example a `Version:` or `Chain ID:` line. If it fails, paste the exact message Seed Vault signed alongside the payload sent, and identify the difference. **Do not loosen verification to make it pass.** If a field genuinely must be accommodated, say so explicitly and explain why it is safe.
3. **The full round trip** ending in `/api/verify-seeker` returning SGT mint `Gv9AN58bVkqWp4w7dNc7nT3cJAavAH1VBi4fpESsCVZn` for the device's wallet. This also closes the last untested item from Brief 02: `claimSgtMint` writing a real mint through a real session.
4. **What Seed Vault displayed for the app identity** — name, and icon behaviour under both the relative path and the data URI.

Anything not run gets named as untested with what would test it.

---

## 7. Standing constraints

- **All code fresh.** Nothing copied from other repos on this machine. Colosseum requires disclosure of pre-existing code and the answer is "none".
- `npm audit` stays at 0. Two Ethelsec security researchers are among the seven judges and the repo goes through an automated audit tool.
- Fail closed. No debug endpoints. No secrets in the repo or the bundle.
- Commits small, meaningful and steady — commit history is a judged surface.
- `tsc --noEmit` passes for root and server. `npm run ci` green.
