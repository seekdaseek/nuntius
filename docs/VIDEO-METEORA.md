# VIDEO-METEORA: subscription launches on Meteora, under 3:00

Replaces the 55 s clip plan of 1 Oct (ops `a03255f`). That plan was written before the mainnet run: its beats assumed a NATX launch and a USDC back, and its line "nuntius keeps nothing" is dropped, because nuntius earns 0.4% of curve trades and half of the locked pool's fees. What stays true, and is shown instead: the executor's balance is the same after every buy as before it.

## Format

- 1920×1080 landscape, the product filling the frame: the Seeker's screen, the backing page, or Explorer. No captions over the screen.
- Narration in the AgentFeed Eternal demo's voice ("charles"), every line matched to its transcript; −14 LUFS.
- The picture shows what the line says, as one walkthrough. Every number on screen and in the voice is read from its source on the day of the render (the pipeline's `checks.mjs` against a `facts.json`).
- Pipeline: `~/Desktop/BRIEF-visum-video.md` and `~/Desktop/visum-video/`; fonts in `~/Desktop/interpres-video-kit`. Sergiu uploads to YouTube.
- Target 2:40.

## Beats

| #   | Time | Picture                                                                                                                                                                          | Voice                                                                                                                                                                                                                        | Source to check before the render                                                               |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | 0:15 | Litmus's README, the line with "909,994 of 920,078 graduations (98.9%) were uncontested", scrolled into view on github.com/omreor/litmus                                         | "Litmus measured it: since April 2025, 98.9% of graduations on Meteora's bonding curves were uncontested. Most curves are filled by their creator, the launchpad's own wallet or a single bundle, with no real competition." | The README line, as of the render date (read 6 Oct: 909,994 of 920,078 as of 29 Sep)            |
| 2   | 0:20 | The Seeker: Launch a token, nimus / NIMUS / SKR / description / image filled, the Seed Vault sheet. Cut to Explorer: `36HcKcHp…`                                                 | "On nuntius a builder launches on a Meteora bonding curve from the Seeker, with one signature. No one can mint more of it, and its name and image can never change."                                                         | Launch tx `36HcKcHp…`; the nimus page's three badges                                            |
| 3   | 0:25 | The Seeker: Back a launch on nimus, "Back NIMUS: 5 SKR every day, for 30 days", the Seed Vault sheet with its finite SKR total                                                   | "Backers say how much, how often and until when. One approval. Seed Vault shows the most it can ever take."                                                                                                                  | The total Seed Vault shows; the grant tx                                                        |
| 4   | 0:25 | Explorer: `383VkA2U…`, the Subscriptions pull and the DBC swap in one transaction, NIMUS arriving in the backer's wallet, the executor's SKR 0 → 0                               | "Each period one transaction pulls the amount and buys on the curve. The tokens land in the backer's own wallet. The executor holds nothing before or after."                                                                | `383VkA2U…` balance changes                                                                     |
| 5   | 0:20 | The backing page `nuntius.ochinimus.app/l/BpYoKp…`: the logo, the three badges, "raised of 50,000 SKR", committed per week, the buys list. Scroll to a browser wallet connecting | "Every launch has a public page: what is raised, what backers have committed each week, and what the token's own accounts promise. Anyone can back it from a browser wallet too."                                            | The page on the render date; `/api/launches`                                                    |
| 6   | 0:25 | Explorer: the proof pool's migration `2gEqP5Af…`, then the DAMM v2 buy `AiFrumeV…`                                                                                               | "When a curve fills, it moves to its regular pool. No keeper came for our proof pool, so nuntius migrated it, and the next buy followed the token to DAMM v2."                                                               | `2gEqP5Af…`, `AiFrumeV…`                                                                        |
| 7   | 0:15 | The Seeker: Revoke on the permission, the Seed Vault sheet. Explorer: `GarcPW1D…` failed, `InvalidAccountOwner`                                                                  | "Revoke takes one approval. The next pull is refused by the chain itself."                                                                                                                                                   | `2VxWUMjd…` (revoke), `GarcPW1D…` (refused)                                                     |
| 8   | 0:15 | The feed `/api/launches` and the nimus page, live                                                                                                                                | "Recurring, capped demand for a launch, on chain. nuntius. Grant once. The chain holds the line."                                                                                                                            | Committed per week and buys, read at render time; third-party figures only if they are not zero |

## Footage

- **Exists:** Explorer pages for every signature above (all in `docs/meteora/CONFIGS.md`), the live backing pages, the Litmus README.
- **To record on the Seeker** (`adb shell screenrecord`, Sergiu's taps for every Seed Vault sheet):
  - beat 2: the Launch form filled with nimus's values up to the Seed Vault sheet, then dismissed. The launch itself is shown on Explorer, so nothing is launched twice;
  - beat 3: a back permission on nimus up to the Seed Vault sheet; approving it is Sergiu's choice, since it starts real buys;
  - beat 7: Revoke on an existing permission, approved.
- Explorer, not Solscan, for captured transaction pages: Solscan blocks automated capture.

## Rules for the voice

- No claim the picture does not show. No "nuntius keeps nothing".
- The 98.9% is Litmus's measurement and is attributed to Litmus on screen and in the voice.
- The proof pool is a proof, not traction: Litmus would call its graduation uncontested. It is shown only for the migration and the buy that follows it.
