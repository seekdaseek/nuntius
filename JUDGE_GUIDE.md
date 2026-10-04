# JUDGE_GUIDE — install and verify in five minutes

**Demo video (1:45):** https://youtu.be/rXs5zppcYKs, the whole flow on a Seeker before you install anything.

Three things to check, in order of how little they ask of you:

1. **The mainnet proof** — open links, no install (1 minute).
2. **The app on a Seeker** — install the APK, grant, watch, revoke (3 minutes).
3. **The tests against the real program** — one script on any Linux or macOS machine (1 minute of your time; first build takes longer).

---

## 1. The mainnet proof (no install)

On 22 September 2026, the full life cycle ran on **mainnet-beta with real USDC**, signed by Seed Vault on Seeker `SM02E4060327059`. Cap: 10,000 base units (0.01 USDC) per 60-second period. Open each link and check the one thing listed.

| Step                                 | What to check                                                                             | Link                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `initSubscriptionAuthority`          | Program `De1egAFM…avR44`; the user is the only signer                                     | [explorer](https://explorer.solana.com/tx/bBNbUgwhwFAmb8GM7L9AwJJjcn8UFCymrHaajLXS9R4uTTxvNUwKGVSNkj5A8EAmVuRW2PJBzjrBCuZUqGS2Sks)  |
| `createRecurringDelegation`          | The per-period amount and period in the instruction data                                  | [explorer](https://explorer.solana.com/tx/5r7YnGrbRCPb74W1t1p1xDzMtaTPL47orLsbGmpiMgAkmwbEfU9MKW7hGpZP4mcwv1cFLAXTq8pGWNsFUGinugMw) |
| Pull of **2× the cap**               | **Failed** with `custom program error: 0x190`. It landed, so the refusal is on the ledger | [explorer](https://explorer.solana.com/tx/3RpcCkkLmwq5wT4moE1TQrXpnjRn36kWgmtRah9Y6kZuo3n5bVYdWTvnov4zQMXEr3vcS15pbE7jJENPmaZpWyR7) |
| One base unit after the cap was used | **Failed**, `0x190`                                                                       | [explorer](https://explorer.solana.com/tx/5ryxPMPjNXzYCGtA9yQ6ZGG2enVmXjyN9PnotF9x1h7N9MqZjS5Kk9K1YQsh4661Hn7xNPhn1N6pcoQ1TKAjsDpd) |
| `revokeDelegation`                   | The delegation account closes                                                             | [explorer](https://explorer.solana.com/tx/Vh2yr9VTe8YeqcGqffuVZEa26ZicoJP3FV5k8y4FYNXtECCEXu6bvbWZ6u8XuRXWP6XSp5hxUpq1X97TYmsb1wT)  |
| `revokeSubscriptionAuthority`        | The token account's delegate is cleared                                                   | [explorer](https://explorer.solana.com/tx/2doDFNXUxvBcstNJJDwjWCyrEGMLEugQAUeXTth4eCJnsXHb3S89s17Jtr34Raxg25vwQF1MGTC5cMFjgVsij9Y8) |
| Pull after revocation                | **Failed**: the delegation is gone                                                        | [explorer](https://explorer.solana.com/tx/cfESoUjxbXF341RwzBtqyuBMAZ7rwA6mhbJCqQ1fqs91Gc48eFd5yzqLfT2vnazxJwB2JL7WcuSqzEzTtM5GPzm)  |

The four successful pulls are recorded in README.md with their signatures shortened. Each has exactly one signer, the delegatee. The user signed nothing after authorizing.

That run used **two** Seed Vault approvals (init, then create). This build cuts it to **one** (section 3).

## 2. The app on a Seeker

**v1.0.1** (4 Oct, security hardening: the app checks every transaction before Seed Vault, tokens in the keystore, server-side sign-out; see README and SECURITY.md §7) is the release below. It was installed over v1.0.0 on the Seeker on 4 Oct and passed a grant, its first pull and a revoke on mainnet (README, "v1.0.1").

**APK:** https://github.com/seekdaseek/nuntius/releases/tag/v1.0.1 (`nuntius-1.0.1.apk`, sha256 `60aba5095d2f976e75939a3dfd1caf8f00bc7d27f49ef6533271e45cf6d6e2b8`, signed with the release key). v1.0.0 stays at https://github.com/seekdaseek/nuntius/releases/tag/v1.0.0.

1. **Install.** On the Seeker, open the release page, download `nuntius-1.0.1.apk`, allow the install. The app talks to mainnet through the nuntius backend.
2. **Sign in** (about 20 s). Tap **Sign in with Solana** and approve in Seed Vault. The backend verifies the signature with a single-use nonce and checks the Seeker Genesis Token. A Seeker wallet shows **✓ Seeker verified**; any other wallet shows **Basic tier** and can hold one permission.
3. **Look at your permissions.** Home lists every Subscriptions delegation your wallet has granted, to nuntius or to any other app, each with the cap left and a countdown. If no other app has one, the green row with the shield says so. That is the guard.
4. **Grant a permission** (about 60 s).
   - Tap **+ New permission**.
   - Fill the sentence: a name, an amount (for example `0.01`), USDC, **day**, **7 days**. Paste a payee address that already holds USDC.
   - Read the green box: the server's parse of the exact terms the transaction carries.
   - Above **Approve in Seed Vault**, one line says what Seed Vault will show, for example _"Seed Vault will show 0.07 USDC."_ **Why?** explains it. Approve **once** in Seed Vault; its sheet shows that finite amount, not "Unlimited".
   - Within about 15 s (4–14 s on the Seeker) the first payment goes out and a push arrives: _"… received 0.01 USDC"_. Tap it, with the app open or closed, to open the receipt with its cap meter and Explorer link.
5. **Watch the chain refuse.** Available if the server has `DEMO_ENDPOINTS=1` for judging. On the permission's card tap **Try to take more**. The server asks the program for one base unit more than is left. The push reads _"Refused by the chain"_, and the receipt shows the failed transaction with `0x190`.
6. **Revoke** (about 20 s). Tap **Revoke** and approve once. If it was the last permission on USDC, home reads **Token account delegate: none**.
7. **Clock in.** On a Seeker wallet, open **Clock in**: the last 24 hours and your streak. Pick the digest hour with **Earlier** and **Later**, then **Send it at …**. The home-screen widget (long-press the home screen → Widgets → nuntius) shows the cap left and today's clock-in.

Steps 1–7 were run on Seeker `SM02E4060327059` on mainnet in four rounds between 30 Sep and 1 Oct 2026; the last, on build `57eb4e1`, is the release. The signatures are in README.md, _What is proven_.

**Identity check, no install.** `curl -s https://nuntius.ochinimus.app/.well-known/assetlinks.json` shows the package and the release certificate fingerprint that wallets verify the app against. Checked on 30 Sep 2026: it matches the APK's signer.

## 3. The tests against the real program (any machine)

```bash
git clone https://github.com/seekdaseek/nuntius && cd nuntius
scripts/localnet.sh &          # fetches Agave 3.1.10, builds the program at release commit 364a419, starts a validator
cd server && npm ci && npm run test:localnet
```

Measured output (2026-10-04, Linux x86_64):

```
ℹ tests 117
ℹ pass 117
ℹ fail 0
```

Things worth reading in the output:

- `grant: one transaction, one signer, authority created in the same transaction`. This is the one-approval grant, using the program's `UNKNOWN_INIT_ID` same-slot check.
- `over-cap pull: the chain refuses with 0x190 and nothing moves`. It prints the refused signature and `{"InstructionError":[0,{"Custom":400}]}`.
- `a lost transaction is replaced only after its blockhash is dead — never doubled`. This is the executor's idempotency.
- `guard: receipts for delegations nuntius did not create`.

`npm test` without a validator passes 76 tests and reports the 7 localnet suites as skipped. At the repo root, `npm run test:core` runs the app's 44 logic tests, and `npm run test:e2e` runs 11 tests on the web build (cold-start tap, fonts, layout, BACK, launches hidden).

## 4. Subscription launches (Meteora DBC)

**Hidden in v1.0.1** unless the server runs with `MANDATE_LAUNCHES=1`; it stays off until the Meteora device run. The steps below are for a server with it on.

- **On the phone:** New permission → **Back a Seeker builder** → paste a DBC pool → one Seed Vault approval. The first buy comes within about 10 minutes. Its receipt reads "Bought … for … USDC/SKR" and opens on Explorer, where the bought tokens are in the backer's own account.
- **Launching:** **Launch your own token** (Seeker-verified wallets only) creates a DBC pool priced in SKR or USDC with one signature.
- **Without a phone:**
  - `GET https://<server>/api/launch/<pool>` returns the curve's progress, the route and the committed recurring demand.
  - The buy composer and its tests are `server/src/meteora.ts` and `server/src/meteora.test.ts`.
  - The executor tests are `server/src/executor-back.test.ts`: custody, skip, route switch, idempotency.

## Where to look in the code

| Question                                | File                                                              |
| --------------------------------------- | ----------------------------------------------------------------- |
| How is one signature enough?            | `server/src/mandate-chain.ts`, `grantInstructions`                |
| What stops a double pull?               | `server/src/executor.ts` (header comment, `claimPull`, `resolve`) |
| What happens on 0x190?                  | `executor.ts`, `resolve` → `refusalReceipt`                       |
| How are other apps' pulls seen?         | `server/src/guard.ts`                                             |
| What does the user read before signing? | `server/src/mandate-text.ts`, `describeMandate`                   |
| What does the cap not cover?            | `SECURITY.md` §3                                                  |
