# JUDGE_GUIDE — install and verify in five minutes

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

> **APK link: filled in on the Mac when the release is published — the APK is published to a GitHub release after the device checks.** Until that line is replaced with a URL, the APK has not been published.

1. **Install.** On the Seeker, open the release page, download `nuntius.apk`, allow the install. The app talks to mainnet through the nuntius backend.
2. **Sign in** (about 20 s). Tap **Sign in with Solana** and approve in Seed Vault. The backend verifies the signature with a single-use nonce and checks the Seeker Genesis Token. The pill reads **Seeker verified**.
3. **Look at Permissions.** This lists every Subscriptions delegation your wallet has granted, to nuntius or to any other app, each with the cap left and a countdown. If there are none, the green card says so. That is the guard.
4. **Create a mandate** (about 60 s).
   - Tap **New mandate**.
   - Name it, paste a payee address that already holds USDC, enter `0.05`, choose **day** and **30 days**.
   - Read the green sentence. It is the server's parse of the exact terms the transaction carries.
   - Tap **Authorize with one approval** and approve **once** in Seed Vault.
   - Within about 30 s the first payment goes out and a push arrives: _"… received 0.05 USDC"_. Tap it to open the receipt with its Explorer link.
5. **Watch the chain refuse.** Available if the server has `DEMO_ENDPOINTS=1` for judging. On the mandate card tap **Try to take more**. The server asks the program for one base unit more than is left. The push reads _"Refused by the chain"_, and the receipt shows the failed transaction with `0x190`.
6. **Revoke** (about 20 s). Tap **Revoke** and approve once. The mandate disappears. If it was the last one on USDC, the footer reads **Token account delegate: none**.
7. **Clock in.** Open the **Clock in** card: the digest of the last 24 hours and your streak. Set the digest hour with − and +. The home-screen widget (long-press the home screen → Widgets → nuntius) shows the cap left and today's clock-in.

Steps 4–7 on the Seeker are **UNTESTED in this build**. A device checklist records them before submission.

**Identity check, no install.** `curl -s https://nuntius.ochinimus.app/.well-known/assetlinks.json` shows the package and the release certificate fingerprint that wallets verify the app against. **UNTESTED until the backend is deployed.**

## 3. The tests against the real program (any machine)

```bash
git clone https://github.com/seekdaseek/nuntius && cd nuntius
scripts/localnet.sh &          # fetches Agave 3.1.10, builds the program at release commit 364a419, starts a validator
cd server && npm ci && npm run test:localnet
```

Measured output (2026-09-27, Linux x86_64):

```
ℹ tests 51
ℹ pass 51
ℹ fail 0
```

Things worth reading in the output:

- `grant: one transaction, one signer, authority created in the same transaction`. This is the one-approval grant, using the program's `UNKNOWN_INIT_ID` same-slot check.
- `over-cap pull: the chain refuses with 0x190 and nothing moves`. It prints the refused signature and `{"InstructionError":[0,{"Custom":400}]}`.
- `a lost transaction is replaced only after its blockhash is dead — never doubled`. This is the executor's idempotency.
- `guard: receipts for delegations nuntius did not create`.

`npm test` without a validator runs 31 tests and reports the 5 localnet suites as skipped. `npm run test:core` at the repo root runs the app's 10 logic tests.

## Where to look in the code

| Question                                | File                                                              |
| --------------------------------------- | ----------------------------------------------------------------- |
| How is one signature enough?            | `server/src/mandate-chain.ts`, `grantInstructions`                |
| What stops a double pull?               | `server/src/executor.ts` (header comment, `claimPull`, `resolve`) |
| What happens on 0x190?                  | `executor.ts`, `resolve` → `refusalReceipt`                       |
| How are other apps' pulls seen?         | `server/src/guard.ts`                                             |
| What does the user read before signing? | `server/src/mandate-text.ts`, `describeMandate`                   |
| What does the cap not cover?            | `SECURITY.md` §3                                                  |
