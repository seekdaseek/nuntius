# BRIEF 05 — mandatum: the spike

Working directory: `/Volumes/D/nuntius`. Confirm the absolute path first.

Read `BIBLE.md`, then this. Briefs 01–03 are done. Brief 04 has one open item, carried below.

**The measurement payload from earlier planning is dead. Do not build it.** The new payload is below. Everything already built — auth, SGT gate, push, evidence screen, RPC proxy — is payload-agnostic and carries over unchanged.

**This brief is a spike, not the product.** Its only job is to prove or kill the core mechanic in the smallest number of steps. Do not build UI polish, do not build the rule engine, do not build the digest. If the spike fails, we need to know in a day.

---

## 0. Finish Brief 04 first

The release APK predates the auth fix (`66ab4e8`) and is stale. Build a fresh release variant off current HEAD and close the cold-start proof:

1. App not running — `am kill`, never `am force-stop` (Android withholds FCM from force-stopped apps by design).
2. Send a push via `/api/push/test`.
3. Tap it.
4. It must cold-launch and land on the alert screen, not index. Report whether the splash renders correctly in release — that was the documented debug-build failure.

Skip the permission-prompt screenshot. The mechanism is proven and re-triggering it put the wallet into a bad state last time.

---

## 1. What we are building, and why

**Money that moves without the user opening the app.**

The user sets a rule once. Seed Vault approves a delegation once. After that it executes on a schedule — a recurring deposit into yield, a scheduled buy, a capped allowance a merchant or agent can draw against. Push fires on every execution. The cap resets each cycle, the user sets the terms, and revocation is one transaction.

### The primitive this is built on

**Solana Subscriptions & Allowances** — the Subscriptions Delegation Program. Native, open source, live on mainnet, audited by Cantina, built by Moonsong Labs with the Solana Foundation, announced 2 June 2026.

```
Program ID   De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44
Docs         https://solana.com/docs/payments/subscriptions/overview
Repo         solana-foundation/subscriptions
Demo app     linked from the docs overview page
```

Three delegation models:

| Model                | What it does                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Fixed delegation     | Spend up to a fixed total, optional expiry. Solana's own docs call this the building block for AI agents operating within a budget. |
| Recurring delegation | Spend up to a limit that resets every period — daily, weekly, monthly. Terms set by the user, not the merchant.                     |
| Subscription plan    | A merchant publishes billing tiers; approved collectors charge subscribers each period.                                             |

Why it exists at all, in their words: a Solana token account can only have **one** approved authority at a time, which makes it impossible for one wallet to safely hold several spending arrangements for the same token. The program gives each (user, mint) pair a program-controlled **Subscription Authority**. The token account approves that authority once; the program then checks every requested transfer against a separate record defining who may pull, how much, and when it expires or resets. **The Subscription Authority cannot move funds by itself.**

Supports SPL Token and Token-2022, including transfer hooks — the SDK resolves hook accounts automatically for `transferFixed`, `transferRecurring`, `transferSubscription`.

### The part that connects to what we already built

The program **emits on-chain events via self-CPI**, all registered in the published IDL: `FixedTransferEvent`, `RecurringTransferEvent`, `SubscriptionTransferEvent`, plus `SubscriptionCreatedEvent`, `SubscriptionCancelledEvent`, `SubscriptionResumedEvent`, `PlanUpdatedEvent`.

**Those events are what the push pipeline subscribes to.** Every delegated transfer becomes a notification with an evidence trail, using the FCM infrastructure already proven on the device.

### Why this fits both hackathons

- **Clock In** — Seed Vault is the mechanism, not decoration. The app acts on days the user never opens it, which is the stickiness criterion satisfied structurally. First mobile use of a primitive Solana shipped in June.
- **Colosseum** — payments infrastructure with a consumer face, built on an audited program so there is no unaudited-code risk. Fee-on-flow business model, already validated at 0.25% by Solana Mobile's own Earn Vault.

Both descriptions are true of the same repo with no repositioning.

---

## 2. The spike — prove or kill, smallest possible path

Nothing beyond this section gets built until this works.

**The goal: one recurring delegation, authorized through Seed Vault on the Seeker, executing once on schedule, with a push on execution.**

### Step 1 — read before writing

Read the docs overview and the following pages in that section, and the `solana-foundation/subscriptions` repo. Report:

- the JS/TS SDK package name and version, and whether it works with `@solana/kit` (the app is on kit, not web3.js v1 — do not drag in the legacy dependency tree that was already removed for audit reasons)
- the instruction sequence to create a Subscription Authority and a recurring delegation
- what the delegate side must call to execute a pull, and what authority it needs
- whether devnet is supported and at what address

Do not proceed on assumptions. If the SDK is web3.js-v1-only, say so immediately — that is a material finding that changes the plan.

### Step 2 — devnet, headless

Server-side only, no app involvement. Using a throwaway keypair on devnet:

1. Create a Subscription Authority for a test mint.
2. Create a **recurring delegation** with a small cap and a short period.
3. From a separate delegate keypair, execute a pull.
4. Confirm the transfer landed and the cap decremented.
5. Attempt a second pull that exceeds the remaining cap — **it must fail**. Paste the error.
6. Wait for or simulate the period reset and confirm the cap resets.
7. Revoke, and confirm no further pulls succeed.

Paste real transaction signatures and real errors for each. Items 5 and 7 matter most — the whole value proposition is that the limit is enforced by the chain rather than by our code.

### Step 3 — Seed Vault approval on the device

This is the step that actually decides the product.

The delegation must be authorized by the user's real wallet through Mobile Wallet Adapter on the Seeker (`SM02E4060327059`). Not a server-side keypair.

Report: whether Seed Vault signs the authority-approval and delegation-creation transactions cleanly, what the wallet shows the user, and any transaction size or account-count limits hit.

**If Seed Vault cannot sign this flow, the product does not exist. Report that immediately and stop.**

### Step 4 — event to push

Subscribe to the program's `RecurringTransferEvent` for the user's authority. When a pull executes, fire an FCM push through the existing pipeline, with `data.url` pointing at an evidence screen showing what moved, how much cap remains, and when it resets.

Prove it on the device: a scheduled pull executes, the phone lights up, the tap opens the evidence.

### Step 5 — the executor

Something has to call the program on schedule. For the spike, a simple timer on the backend is enough. Note honestly what a production version would need and what it would cost.

---

## 3. Report format

For each of steps 1–5: what you ran, the actual output, and whether it passed. Anything not executed is named UNTESTED with what would test it.

If any step fails in a way that kills the mechanic, stop and say so plainly rather than working around it. A fast kill is worth more than a slow workaround.

---

## 4. Do NOT build in this brief

- Rule creation UI
- The daily digest, streaks or leaderboard
- Multiple delegation models — recurring only
- Yield integration, DCA logic, or any specific use case
- Any renaming of the package id, Firebase project or repo

The display name may become `mandatum` later. The package `app.ochinimus.nuntius` and Firebase project `nuntius-7adb3` stay as they are — renaming them costs an hour and buys nothing.

---

## 5. Standing constraints

- **All code fresh.** Nothing copied from any other repo on this machine.
- Server `npm audit` stays at 0. Root's 18 moderate advisories are inherited scaffold transitives; leave them, do not mask them.
- Fail closed. No endpoint that acts on a delegation the caller does not own.
- No secrets in the repo or the bundle.
- Commits small, meaningful, steady — commit history is a judged surface.
- `tsc --noEmit` passes for root and server, `npm run ci` green.
- Nothing is done until it has been run and observed.
