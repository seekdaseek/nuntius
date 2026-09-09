# BRIEF 02 — corrections, SGT proof, then the client

Working directory: `/Volumes/D/nuntius`. Confirm the absolute path before doing anything.

Read `BIBLE.md` and `BRIEF-01-auth.md` first. This brief corrects two things in them and adds the next work.

---

## A. Corrections to the documents you were given

**A1. BIBLE.md and BRIEF-01 both overstate SGT transferability.** They say SGTs are "transferable between wallets". The Solana Mobile docs say something narrower, verified 2026-09-09 at `https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token`:

> The Seeker Genesis Token can only be transferred between a user's wallet accounts on a permissioned basis within the Seed Vault Wallet. A transfer occurs when a user changes their primary account in the Seed Vault Wallet. The mint address of the SGT remains the same when it is transferred.

Keying uniqueness on the mint address is still correct. Fix the wording in BIBLE.md so future sessions do not inherit the wrong model.

**A2. `--env-file-if-missing` does not exist in Node.** You used it in `server/package.json`. The real flag is `--env-file-if-exists`. This has already been fixed by hand and verified — the server now starts and prints `domain ochinimus.app · helius configured`.

The consequence matters: **your entire Step 1 proof run never loaded `server/.env`.** Every payload you proved carried `domain: "localhost"`, not the configured domain. Re-run proofs 1 through 4 with `.env` actually loaded and paste the new output. The nonce, replay, expiry and domain-binding logic all look correct — this is about proving them under the real configuration.

Commit the flag fix with a message that says what it was.

**A3. `server/.env` exists and is correct.** Created before your session: `HELIUS_RPC` (live, `getHealth` returns ok), `NUNTIUS_DOMAIN=ochinimus.app`, `PORT=8787`. It is `chmod 600` and gitignored. Do not create it, overwrite it, print it, or commit it. Your path guard hides it from you; that is intended.

---

## B. Prove the SGT check against live Helius

This is the piece you flagged yourself as unverified, and it is the core of the product's identity gate. It does not get built on top of until it is proven.

**Reference implementation** is on the docs page above. Read it before testing yours. The constants, verified independently:

```
Mint Authority      GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4
Metadata Address    GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te
Group Address       GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te   (same as metadata, intentional)
Token-2022 program  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Three things the docs require that are easy to miss:

1. **Pagination.** The reference loops on `paginationKey` until it is absent. A single unpaginated `getTokenAccountsByOwnerV2` call can miss accounts. Confirm yours paginates.
2. **Skip zero-balance token accounts.** Transferring an SGT out leaves the old token account open at balance 0, and it must not count as current ownership.
3. **Return the mint address, not a boolean.** Required for the anti-sybil record.

You replaced the docs' `@solana/spl-token` path (`unpackMint`, `getMetadataPointerState`, `getTokenGroupMemberState`) with hand-rolled `jsonParsed` extension parsing to avoid 9 audit vulnerabilities. That trade is right. But it means **your parser has never seen a real Token-2022 mint with these extensions**, and it is the most likely thing in the backend to be subtly wrong.

**Test wallet:** `4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7`

⚠️ **Read this before concluding anything from the result.** The docs state the SGT "is minted into the primary account in a user's Seed Vault Wallet". The address above is the owner's main SOL address and **may or may not be that primary Seed Vault account**. So:

- If your check returns a mint address — the parser works, print the full mint address and the raw account shape you parsed.
- If it returns null — **do not report the parser as broken, and do not report the wallet as having no SGT.** Print the raw `getTokenAccountsByOwnerV2` response for that wallet: how many Token-2022 accounts came back, their mints, their balances. Then say which of these it is: the wallet holds no SGT because it is not the Seed Vault primary account, or the wallet holds an SGT-looking mint that your parser failed to classify. Those are different failures and the raw output distinguishes them.

Either way, paste the actual JSON shape you received. If the shape differs from what your parser assumed, fix the parser and say what differed.

---

## C. Then the client — Step 2 of the build order

Only after B is resolved.

From your own Step 0 report, the template's state is:

```
AppIdentity      { name: 'kit-expo' }   — no uri, no icon
sign-in          result discarded, success is a console.log
nonce            none, anywhere
networks         devnet + testnet only, no mainnet
```

All four change.

**C1. AppIdentity** in `MobileWalletProvider`:

- `name`: `nuntius`
- `uri`: `https://ochinimus.app` — absolute. The MWA spec recommends wallets decline authorization when identity carries no uri.
- `icon`: a path **relative to `uri`**, or a `data:` URI holding base64 SVG/WebP/PNG/GIF. An absolute http(s) URL is neither and may be rejected. The Kotlin client accepts only the relative path.

Note in `server/README.md` as an open item: wallets verify the app by checking Digital Asset Links at `https://ochinimus.app/.well-known/assetlinks.json` against the APK signing key. That file does not exist yet and needs the release keystore fingerprint.

**C2. Mainnet.** Add a mainnet cluster. `createSolanaMainnet` requires an explicit url — there is no default public mainnet endpoint. The url must come from config, and the Helius key must not be embedded in the app bundle. Decide and state how you are handling that: either the app talks only to our backend for anything needing a key, or a public endpoint is used client-side for reads. Say which and why.

**C3. The real sign-in flow**, replacing the discard-the-result version:

1. `GET /api/siws-payload` from the backend
2. `signIn` with that payload via `useMobileWallet`
3. `POST /api/siws-verify` with `{ nonce, signInResult }`
4. On success, `POST /api/verify-seeker`
5. Persist session and the Seeker-verified flag via TanStack Query

**C4. Three visibly distinct UI states:** disconnected, connected but not Seeker-verified, Seeker-verified. Keep `constants/app-styles.ts` conventions. No new UI library.

**C5. Then run it on the device** (`SM02E4060327059`, `adb reverse tcp:8787 tcp:8787` already set) and report:

- whether Seed Vault's signed message verifies against `verifySignIn` **field for field** — you flagged that `verifySignIn` is strict and will reject if the wallet adds lines the payload does not carry. This is the highest-risk unknown in the client.
- the SGT result for the device's actual primary account.

If Seed Vault's message format does not match, report the exact difference between what you sent and what came back signed. Do not loosen the verification to make it pass without saying so explicitly.

---

## D. Standing constraints

- **All code fresh.** Nothing copied from other repos on this machine. Colosseum's rule is that pre-existing code must be disclosed on the submission form, and the answer here is "none".
- **Two security researchers from Ethelsec are among the seven judges**, and the repo goes through an automated audit tool. Keep `npm audit` at 0. Fail closed. No debug endpoints.
- **Commits are a judged surface.** Small, meaningful, steady.
- `tsc --noEmit` must pass for both root and server.
- Nothing is "done" until it has been run and the output observed. Untested paths get named as untested along with what would test them.
