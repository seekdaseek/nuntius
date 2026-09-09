# BRIEF 05 — the measurement, the rule engine, the evidence screen

Working directory: `/Volumes/D/nuntius`. Confirm the absolute path first.

Read `BIBLE.md`, then this. Briefs 01–03 are done. Brief 04 is done except one item, carried below as section 0.

**This is the brief that decides whether nuntius wins. Everything before it was plumbing.**

---

## 0. Finish Brief 04 first

The release APK built earlier predates the auth fix (`66ab4e8`) and is stale. Build a fresh release variant off current HEAD and close the cold-start proof:

1. App not running — use `am kill`, never `am force-stop` (Android withholds FCM from force-stopped apps by design).
2. Send a push via `/api/push/test`.
3. Tap the notification.
4. It must cold-launch and land on the alert screen, not index. Report whether the splash renders correctly in release — that was the documented debug-build failure.

Skip the permission-prompt screenshot. The mechanism is already proven end to end and re-triggering it put the wallet into a bad state last time.

Then update `BIBLE.md` build state with what is now proven, and add these environment facts that cost retries:

- `expo prebuild --clean` wipes `android/local.properties`
- `ANDROID_HOME` is not set in every shell; the SDK is at `/Volumes/D/Android-sdk`
- the "about 3 minutes" figure in BIBLE.md is for incremental builds; a `--clean` full native rebuild on this 8GB machine takes considerably longer

---

## 1. The measurement — DECIDED

**The realisable-exit gap on Solana lending collateral.**

Replace `BIBLE.md` §8 (currently "OPEN — what it alerts on") with this decision and the reasoning below. The other four candidates are dead:

- Realized-vs-advertised APY drift — occupied. YieldCompass took a Frontier Top 25 slot and is open-sourcing its methodology.
- Unlock and vesting cliffs — saturated. CryptoRank already ships portfolio-integrated unlock alerts, free.
- Agent-spend anomalies — novel, but the payer is an operator watching a server, not a person carrying a phone. Parked as an AgentFeed feature.
- "Wallet-scoped, before it's public" — a shape, not a measurement.

### What it actually computes

A lending protocol marks your collateral at `oracle_price × amount`. That mark assumes marginal-token liquidity — the price for selling *one* token. It is not what your *position* would clear at.

The realisable value is what that exact amount would actually fetch right now, routed across live liquidity, including price impact.

```
mark        = oracle_price x amount
realisable  = proceeds of routing a sell of `amount` across live liquidity, now
gap         = (mark - realisable) / mark
```

The user is alerted when the gap crosses their threshold, and — this is the sharper alert — when the gap is large enough that the position is effectively under-collateralised **even though the protocol's health factor looks fine**, because the health factor is computed from the same marginal mark.

### Why this survives where the others died

Dialect commoditized generic transaction and balance alerts, so any payload already visible in a wallet is dead on arrival. This one is not visible anywhere: it is a computation over private state (your position size) and public state (live depth). It cannot be looked up. Every alerting product indexed in The Grid is classified developer tooling, messaging protocol, risk assessment or data terminal — **not one is a consumer app**. The computation exists in institutional risk tooling; nobody delivers it to the holder whose position it describes.

### Why Solana specifically

The collateral, the pool depth and the positions are all public on-chain state; off-chain finance hides exactly these inputs. And routing depth lives in on-chain AMMs you can simulate against through a single universal router, which makes the computation tractable in a way fragmented venue-by-venue infrastructure elsewhere does not.

---

## 2. Build the measurement engine first, server-side, no UI

Do not touch the app until this produces a defensible number. If the number is wrong, everything else is decoration.

### Verify before building — do not take any of this on trust

I am giving you the shape, not the API surface. Establish each of these live and report what you find:

1. **Position source.** Which Solana lending protocol, and how to read a wallet's collateral positions from it. Kamino is the largest by TVL and is the default target unless you find a reason otherwise. Determine whether positions are readable over a public API or require RPC account decoding. Report the exact endpoint or account layout you end up using.
2. **The mark.** How the protocol values that collateral — which oracle, what price, at what staleness. The alert compares against *their* number, so read *their* number, not a price you fetched elsewhere.
3. **Realisable value.** Quote selling the exact position size through Jupiter and read the effective execution price including price impact. Verify the current endpoint, the response fields, and the rate limits on the free tier before designing the polling cadence.
4. **Sanity floor.** A quote for a trivial size gives you the marginal price. If your computed marginal price disagrees materially with the protocol's oracle mark, something is wrong with your inputs — surface that as a refusal, not as a gap.

### Non-negotiable behaviours

- **Refuse rather than guess.** If depth data is unavailable, the quote fails, the position can't be read, or the result is implausible, the output is an explicit refusal state with a reason — never a number. A wrong gap number in front of judges who trade is fatal to credibility.
- **Every computed gap is stored with its inputs**: position size, oracle mark used, quote route, effective price, timestamp, and the transaction or account references needed to reconstruct it. The evidence screen renders these. No stored gap without its evidence.
- **Timestamp everything.** A gap is only true at an instant.

### Prove it

Report actual output, not descriptions:

1. The gap computed for a real wallet holding a real position — report the wallet, the position, the mark, the realisable value, and the gap.
2. The same computed for a deliberately oversized hypothetical position, showing the gap widening with size. This is the whole thesis in one table and it belongs in the demo.
3. A refusal case, triggered honestly.
4. Timing: how long one evaluation takes, and what that implies for how many users can be evaluated per minute on the free Jupiter tier.

If no test wallet with a real position is available, say so and say exactly what you need. **Do not fabricate a position.**

---

## 3. Rule engine

Only after section 2 produces defensible numbers.

- A rule is: a wallet, a position, a threshold, a notification channel. Stored server-side, owned by an authenticated session.
- Evaluation runs on a schedule. Free tier evaluates less often than the SGT-verified tier — that is the paid-tier mechanic and it must be real, not cosmetic.
- Fire once per crossing, not once per evaluation. A gap sitting above threshold for an hour is one alert, not sixty. Implement hysteresis and record why a rule did or did not fire.
- Every fired alert writes an evidence record from section 2 and pushes with `data.url` pointing at it.

---

## 4. Evidence screen

The screen a notification opens. This is where 25% User Experience and 25% Presentation are won or lost.

It must show what was measured, when, and how to verify it independently:

- the position and its size
- the protocol's own mark
- the realisable value and the gap, as a number and as a proportion
- the route the quote took
- the timestamp
- links out to Solscan / the protocol so a judge can check the claim

**Never a bare number.** The product's credibility is that it shows its work, because it is contradicting the protocol's own health factor.

---

## 5. Daily digest

Stickiness is 25% of the Clock In score and the app must have a reason to be opened on days nothing fires.

- One push per day at a user-set time, on the `digest` channel, summarising current gaps across the user's tracked positions.
- Streak counter on consecutive acknowledged days.
- Leaderboard keyed to `.skr` name, SGT-gated so one device is one entry.

Build the digest. The streak and leaderboard are lower priority — say so if you run short rather than half-building them.

---

## 6. What the demo has to show

Build toward this shot, because it is the submission:

A real position on a real Seeker. A notification arrives saying the collateral cannot be exited at its marked value. Tap it. The evidence screen shows the mark, the realisable value, the gap, the route and the timestamp, with a link to verify. No dashboard was opened. Nobody went looking. The phone knew first.

---

## 7. Standing constraints

- **All code fresh.** Nothing copied from any other repo on this machine, including the owner's own earlier work on this thesis. This is a hard rule for both hackathons and the Colosseum pre-existing-code disclosure answer is "none".
- Server `npm audit` stays at 0.
- Fail closed everywhere. Refusal beats a wrong number.
- No secrets in the repo or the bundle.
- Commits small, meaningful, steady — commit history is a judged surface.
- `tsc --noEmit` passes for root and server, `npm run ci` green.
- Nothing is done until it has been run and the output observed. Untested paths get named, with what would test them.
- **Output is a measurement, never advice.** Never phrase a gap as a recommendation to act.
