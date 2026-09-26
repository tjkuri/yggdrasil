# Journal
Need a file to keep track of why I chose to so certain things.
The front end repo mimir has its own version of this, trying to keep notes in the repo that best makes sense but occasionally some things are relavent to both (e.g., the addition of a new stat to track or a new sport to include, that overarching kind of thing will probably be thrown into Mimir's Journal.md)

## 2026-09-26

**What changed**
- Added opponent-adjustment to NFL QB passing yards distributions: `config/nfl.js` + `services/nflDefense.js` compute per-team `pass_ypa_factor` and `rush_stop_factor` from nflverse weekly stats, blended current+prior season (recency-weighted) and shrunk toward league average by sample size.
- `nflverseStats.buildScopedDistributions` takes an optional `matchupFactor` (default 1.0, so `/qb/passing-yards` is unaffected) and rescales every historical game before computing the distribution; each scope now also returns `raw_mean` for a "vs raw" comparison.
- `routes/nfl.js` resolves the opponent abbr from the upcoming event and wires the matchup factor into `/qb/analysis`; response gains a top-level `matchup` object.

**Decisions**
- Used yards-**per-attempt** allowed, not total yards allowed, for the pass factor. Checked first: raw total-yards-allowed ranking put PIT as the league's *worst* pass defense in 2025 — it isn't, it just faces 36 attempts/game (most in the league) to BUF's 25. YPA isolates the actual defensive trait; total yards mostly measures how often the team gets thrown at.
- Added a second, weaker signal from run-defense strength ("pass funnel" — a stout run D pushes opponents to throw more, independent of pass efficiency; this is the industry term PFF/NBC use in their weekly funnel reports). Verified against 2025 data before committing: corr(rush_stop_factor, QB attempts faced) = 0.302 — real, but clearly weaker than the efficiency signal, so it gets a dampening exponent (`VOLUME_DAMPEN_EXP = 0.35`) and heavier shrinkage (`SHRINK_K_RUSH = 12` vs `SHRINK_K_PASS = 8`).
- Shrinkage denominator must be **distinct games**, not rows — caught this in testing: a passer row is ~1 per team per game, but a rush-allowed row is one per ball-carrier (RB/WR/QB scrambles), so counting rows gave the rush aggregate an apparent n of ~90 against a real ~19 games, which silently defeated the "shrink harder" decision (barely any shrinkage was actually happening). Fixed by deduping on `game_id` before incrementing the weight used for shrinkage, while still summing every row's yards/carries into the point estimate.
- Rescale-and-keep-n (not filter-to-similar-opponents): every historical game gets `× matchup_factor` rather than throwing out games against dissimilar defenses. Preserves sample size, which matters a lot in week 3 of a season.
- No home/away split: checked 2025 data first — home 218.3 vs away 212.9 yds/gm, a 5-yard gap versus a 100-yard spread between best/worst pass defense. Not worth the complexity.

**Why**
- The QB page had zero opponent context — same distribution shown against the Broncos or the Titans. That's the single biggest gap versus the NBA page, which has had an O/D-adjusted model since March.
- Checked the data before picking a formula rather than assuming standard fantasy "yards allowed" stats were usable as-is — they weren't (confounded with volume), which is exactly the kind of thing that's cheap to check and expensive to get wrong.

**Next up**
- Strength-of-schedule is still circular (a defense's rating partly reflects the QBs it happened to face) — the real fix is iterative adjustment (DVOA-style), not a cheap build. Shrinkage damps the worst of it for now.
- Team/skill-position pages are explicitly out of scope for this pass — QB page only for now.


### Same day, cont'd — "Model Read" verdict + a real sanity-check finding

**What changed**
- Added `computeQbVerdict` (`utils/nflMath.js`) — one OVER/UNDER/NO_BET lean per QB, wired into `/qb/analysis` as a `verdict` object. Uses whichever scope the frontend already defaults to (last season → career → current season fallback), so the verdict and the highlighted scope tab never disagree.
- `americanToImpliedProb` + `devigFairProbOver`: proportional de-vig (average fair P(over) across every book quoting both sides) — market comparison uses the fair probability, not a vig-included price.
- `wilsonInterval`: Wilson score interval on the model's own empirical p_over/p_under, used for confidence instead of z-score magnitude.
- No dollar EV — see below.

**Decisions — and a real finding from testing before shipping**
- Went in planning to mirror `nbaMath.js`'s `computeConfidenceAndEV`/`computeRecommendation` (z-score tiers, normalCDF win prob, flat -110 EV) until asked to check industry standards instead of assuming NBA's homegrown approach was right. Two real gaps confirmed by research:
  - Devigging (proportional method) is the standard way to find "edge" — model probability vs. the market's own fair read, not a vig-included price. We already retain both `price_over`/`price_under` per book, so this cost nothing new.
  - Confidence should widen for small samples. NBA's z-score-magnitude-only approach doesn't — a tight-looking variance from 2 games can produce a "confident" z purely because the sample is small. A Wilson score interval is the standard tool for this and correctly won't over-trust a thin sample the way a raw z-score can.
  - Also: NFL retains the full historical array (unlike NBA, which only carries mean+variance forward), so win probability can just be the scope's own empirical p_over/p_under — no need for NBA's parametric normalCDF(z) fallback.
- **Tested against real data before shipping and it failed the smell test**: Mahomes vs. MIA came back OVER / HIGH confidence / 28.6% edge / +$47 EV per $100. The market was pricing that line at ~50% fair (correctly — that's what a well-calibrated line does), while the model's last-season mean (adjusted) sat 37+ yards above it. In a 5-book, heavily-bet NFL player prop market, an edge that size is not a real market miss — it's a sign the model is missing something the book has (game script, weather, injury news, coordinator tendencies) that a season-average-plus-opponent-multiplier model has no way to see.
- Result: **dropped the dollar EV entirely** rather than ship a number implying a level of confidence this model can't back up. Kept the directional lean, confidence, and edge% (still legitimate, still Wilson-gated) but paired them with an explicit in-UI caveat (Mimir's `VerdictCard`) rather than silently presenting a HIGH-confidence pick.
- This doesn't fully resolve the underlying issue — a genuinely large, statistically-real (per Wilson) gap between a coarse model and a sharp market will still show as HIGH confidence, because Wilson protects against small-sample noise, not against the model itself being too simple. Flagging that plainly instead of quietly shipping past it.

**Why**
- The lesson generalizes past this one feature: this model (season average + opponent multiplier) is structurally different from the NBA model (recent matchup-specific O/D inputs, closer in kind to what a book actually uses) — comparisons to a sharp market will read as bigger "edges" than they are until this model has real game-script/injury/weather inputs. Better to say that in the UI than to let a HIGH badge speak for itself.


### Same day, cont'd — prediction logging: the feedback loop the verdict never had

**What changed**
- `services/nflSchedule.js` — resolves `{season, week}` for an upcoming game from nflverse's `schedules/games.csv` release (unlike the weekly stats CSVs, this one lists future games too), matching by `(homeAbbr, awayAbbr)` plus a ±3-day window around the event's `commence_time` — not a caller-supplied season, and not team-pair alone.
- `services/nflLogger.js` — write-once prediction snapshot per `(season, week, player_id)`, using an atomic exclusive write (`{ flag: "wx" }`) so a race between two near-simultaneous calls can't let one silently overwrite the other.
- `routes/nfl.js` — `/qb/analysis` logs a snapshot after computing the verdict, fire-and-forget (a schedule-lookup or logging failure can never surface as a 500 or added latency on the real response).
- Huginn (sibling repo) gained a new `nfl/` engine that reads these snapshots later and grades them against nflverse's actual results — hit rate, calibration by confidence tier, a NO_BET-hypothetical check, mean absolute error. No dollar EV/ROI there either, same reasoning as the verdict itself.

**Decisions, and two real bugs caught by testing before they shipped**
- Built via subagent-driven-development (fresh implementer + reviewer per task, a final whole-branch review at the end) rather than by hand — worth noting because the final review is what caught both of these; neither would have been visible from any single task's diff:
  - **A QB with no posted prop line yet was getting logged anyway**, with `line: null`. That's the *normal* state for any QB more than a few days out from kickoff — and it's worse than useless: it permanently burns the write-once key, so when a real line posts later that week the actual useful snapshot is silently dropped, and it crashes Huginn's grader outright (`actual_yards > None`) once that week is graded. Fixed by adding `line == null` to the logger's guard.
  - **`season` was derived from `new Date().getFullYear()`**, which is wrong for Weeks 17-18 (played in January, when the calendar year has already rolled over) — the schedule lookup would search a dataset for a season that doesn't exist yet and silently return nothing. Fixed by having `getWeekForMatchup` resolve `season` *and* `week` together from the matched schedule row (via the date-window match), instead of trusting a guessed season from the caller.
- Chose date-window matching over the simpler team-pair-only approach from the original plan because it fixes both of the above at once, plus a related edge case: two teams can meet twice in a season (division rivals), and matching on team pair alone with no date check risked a preseason meeting between the same two teams colliding with the regular-season lookup.
- Same trigger/scope decisions as the original spec: on-demand only (a snapshot is logged whenever `/qb/analysis` is actually called, no scheduler), write-once by `(season, week, player_id)` so a later re-check doesn't retroactively "improve" what's graded.

**Why**
- The QB page's verdict math (Wilson/de-vig, dropped-EV) was tested against exactly one real game and found wanting — see the entry above. Without a real feedback loop, that's the only kind of check this model will ever get. This closes that gap the same way `nbaLogger` + Huginn's `nba/` engine already does for the NBA model.
- The two caught bugs are a good argument for the final whole-branch review step specifically: per-task review checks "does this task's diff do what its brief says," which both bugs technically passed — the null-line guard was written exactly as specced, and the calendar-year season derivation was inherited from existing `resolvePlayer` code, not new. Only reviewing the whole feature against realistic operating conditions (a QB before props post; the last two weeks of a season) surfaced either one.


## 2026-03-15

**What changed**
- Added NBA backtest engine: `services/nbaBacktest.js`, `scripts/backtest.js`, and `GET /api/nba/backtest`.
- `loadGradedGames` globs `cache/*-nba-predictions.json`, pairs each with the same-date results file, skips any date not fully final, then calls `gradeGame` for each matched prediction/result pair.
- `gradeGame` handles both V2 (grades `'O'`/`'U'` recs against `actual_total`) and V1 (naive mean baseline, inferred direction from `v1_line - dk_line`). `v1_line: null` treated as no data — excluded from V1 aggregates.
- `computeMetrics` computes overall W/L/P, ROI at -110, and breakdowns: by confidence tier (incl. NO_BET hypothetical), by direction (O/U), by gap-size bucket (0–2, 2–5, 5+), calibration buckets on |z| ranges, and avg absolute miss for both V2 and V1.
- CLI uses `chalk` + `cli-table3` for Bloomberg-terminal-style output: green/red on win rate vs 52.4% break-even, yellow ⚠ warnings on small samples (n < 10), ✓/✗ icons per game row.
- `--days N`, `--team X` (case-insensitive substring match on full team name), `--json` flags.

**Decisions**
- Grading uses `actual_total` (full game including OT) — DK lines grade on the final score, not regulation.
- `opening_recommendation` in the predictions file is `'O'`/`'U'`/`'NO_BET'` (not `'OVER'`/`'UNDER'`) — grading logic matches on the short form.
- NO_BET hypothetical: takes all NO_BET games, infers direction from sign of z_score, grades as if a bet was placed. If the hypothetical win rate is < 52.4%, the filter is doing its job (saving money at -110 odds).
- ROI formula: `((wins × 90.91) − (losses × 100)) / (total_bets × 100) × 100`. Break-even win rate at -110 is 52.38%.
- chalk v4 required (not v5+) — the project is CommonJS and chalk v5 is ESM-only.

**Why**
- Three dates of logged predictions is enough to wire up the grading logic. Numbers will be more meaningful as the sample grows, but the infrastructure is in place.
- Wanted the CLI to be readable at a glance without being garish — green/red on the metrics that matter (win rate, ROI), dim gray for empty/N/A buckets, yellow only for actionable warnings.


## 2026-03-11

**What changed**
- Replaced the naive `mean(lastSix)` model with a proper O/D split projection using exponential recency weighting.
- New `utils/nbaMath.js`: `weightedMean`, `weightedVariance`, `normalCDF` (Abramowitz & Stegun approximation).
- New `config/nba.js`: all the tunable knobs in one place (`SAMPLE_SIZE`, `LAMBDA`, `HOME_BOOST`, `Z_HIGH`, `Z_MEDIUM`, etc.).
- ESPN's `fetchLastNTeamGames` now returns `{ pointsScored, pointsAllowed, isHome }` per game instead of just a flat total. Bumped sample size to 10 games per team.
- `routes/nba.js` now computes: projected home score, projected away score, SD of the total, z-score, confidence tier (HIGH/MEDIUM/LOW), EV at -110, win probability, and a smarter recommendation that gates on z-score + EV (returns `NO_BET` when the edge is below threshold).
- My-line cache keyed as `v2` since the stored shape changed (raw game splits instead of totals).

**Decisions**
- O/D split: `projHome = (homeOff + awayDef) / 2 + homeBoost/2`, same for projAway, then sum. Averaging offense and defense for each side is the standard fantasy/analytics approach.
- Home court: flat +1.5 fallback, but if there are enough home/away split games (≥4 each) it derives the adjustment from the team's own data instead.
- Recency weighting: `λ = 0.96` means a game from a week ago gets ~0.75× the weight of today's game. Tunable in config.
- Confidence thresholds: |z| ≥ 1.5 → HIGH, ≥ 0.8 → MEDIUM, < 0.5 → NO_BET. These are starting points, not gospel.
- EV calculation is vig-adjusted: `P(win) × 0.9091 - P(loss) × 1.0`. If EV ≤ 0 the model passes even when directionally correct.

**Why**
- The old model was just averaging 6 totals. It had no sense of how confident the projection was or whether a given edge was worth acting on. You'd get an OVER recommendation on a 0.2-point gap, which is noise. The z-score gates out those marginal cases.
- Splitting offense and defense separately is more accurate — a team's defensive strength matters differently depending on the opponent's offense. Blending them through the O/D formula is a better prior than just averaging past totals.
- Putting all the constants in `config/nba.js` means I can tune thresholds without hunting through route logic.
- Variance propagation through the projection formula lets the SD mean something real — it's not arbitrary, it's derived from how consistent each team's recent offense and defense has been.


## 2026-03-09

**What changed**
- Added `?refreshOdds=true` to `/api/nba/totals`. On refresh, fresh odds are merged with the existing cache rather than replacing it — finished games disappear from The Odds API but their lines are preserved by keeping any cached entry not present in the fresh response.
- Added opening line snapshot (`*-nba-total-odds-open.json`): written once on first fetch of the day, never overwritten. Used to detect line movement. Response now includes `line_movement: { from, to }` when the DK line has shifted.
- Added `date` field (ESPN game start time) to scoreboard normalization in `espnNbaApi.js`.

**Why**
- Refresh was overwriting the full odds cache with whatever The Odds API currently returns, which drops finished games. Merging was the right fix.
- Opening snapshot enables line movement display without any extra API calls.


## 2026-03-08

**What changed**
- Ripped out BallDontLie, replaced with ESPN's unofficial scoreboard + team schedule endpoints. No API key, no rate limit.
- New `services/espnNbaApi.js`: `fetchTodayScoreboard()` (5-min in-memory TTL) and `fetchLastNTeamGames(teamId, n)` (1h TTL). Team IDs come straight off the scoreboard response so no static mapping needed.
- Moved all the computation (recommendation, discrepancy, record) to the backend. Frontend just renders now.
- Fixed the long-standing `!true` cache bug on my-lines that was forcing a full refetch every single request.
- Deleted `services/ballDontLieApi.js`.

**Decisions**
- Originally planned to use hoopR-nba-data CSV releases (same pattern as nflverse) but the repo has no releases. ESPN is the upstream source for hoopR anyway so just went direct.
- Season year detection: Oct+ → next calendar year, otherwise current year. Matches ESPN's convention.

**Why**
- BallDontLie tightened its free tier to 5 req/min and the cache bug meant we were firing ~21 calls per request. Wasn't worth patching, the architecture needed a real fix.
- ESPN gives us live scores too which was a nice bonus — in-progress games now show the current score on the card.

**Next up**
- Could add a `?refresh=true` param to force a my-lines cache bust, same as the NFL odds endpoint has.
- File cache is still date-keyed which works fine. Would be cleaner to purge old files eventually.


## 2025-08-30

**What changed**
- Added NFL roster pipeline + endpoint:
  - `services/nflverseRoster.js` pulls `roster_{season}.csv` from nflverse releases with a 12h in-memory TTL cache.
  - `routes/nfl.js` exposes `GET /api/nfl/qbs?season=&active=&startersOnly=&limit=`.
  - Each QB includes a canonical `id` (pref GSIS), a friendly `slug` (`last-first`), `team_abbr`, `isActive`.
- Mounted NFL routes in `server.js` and kept NBA routing intact.
- Dependencies: added `cors` and `csv-parse`, bumped `axios`, added `npm start`.
- Tiny cache util: `utils/cache.js`.

**Decisions**
- `isStarter`: not reliable from the 2025 roster CSV (no depth order). We’re currently setting `isStarter: false` and not gating UI on it.
- Introduced `slug` to keep stable quick-pick identifiers (`mahomes-patrick`, `allen-joshua`, etc.), while `id` stays a canonical provider ID.
- Fall back to previous season’s roster if current season file isn’t available yet.

**Why**
- Provide a real QB list to the frontend (instead of a stub), while keeping quick-picks working despite provider ID quirks.
- Keep the server simple + fast with CSV → JSON normalization and TTL caching.

**Next up**
- Add `/api/nfl/qb/passing-yards?player=&line=` using nflverse **player_stats** CSVs; return summaries + histograms.
- (Optional) Derive likely starters by team using last season’s starts/attempts, and annotate the roster output.
- Improve errors/observability: add `/api/nfl/health` details, basic logging, and response schemas.


## 04-03-2024
Short term todos:
1. Update to only re-request the status of games that are currently ongoing
2. Add better error handling, when i was trying to stand something up quickly didnt really do any of this. Dont want to crash, want to handle errors with grace

Long term todos:
1. Use a database to cache data instead of files. 
2. Related to the point above, but if we have a better way of storing data, we can add endpoints to fetch how succesful the existing predictions are.


## 03-21-2024
Going to add some functions to save and retrive from cache. The obvious solution is to add some databases solution but for now since im trying to go fast .json files will do. (maybe next time Ill start at the beginning of the sports season so Im not racing with the end of season)

## 03-17-2024
Going to try to use balldontlie api when available since its request limits are per minute not per month.
### Potential TODO's
- async/await works fine for now, but when getting 'myLine' for all the games in a game slows down because all the calls are sequential. In the future if this becomes an issue we should look at places where there are a lot of consecutive calls and swap it out for get/then/Promises architecture + whatever other changes might ensue.

## 03-16-2024
I think I may have done more work than needed. I think the odds endpoint does all the things the games endpoint does. So i dont think i need function to fetch from both. Silverlining the games endpoint doesnt count towards your request quota so i havent been eating into it yet.

## 03-15-2024
Starting with recommendations on over and under lines on NBA games. Looking at APIs that I can use.
* Promising:
    * not sure why yet but when I try to do `await axios.get()` these apis error out for me (api-sports.io didnt) but when i try `get(..).then(...)` this seems to work.
    * [odds-api](https://the-odds-api.com)
        * will probably use this to get games in a given day
    * [balldontlie](https://www.balldontlie.io/#introduction)
        * use this to get score from previous few games
* Looked at but passed on
    * [https://api-sports.io](https://api-sports.io)
        * Found that the documentation wasnt too helpful. In practice returns didnt exacly match the expected from docs. Docs also didnt make it clear when search params where required or not. Ultimately didnt have enough functionality to serve my needs, there seem to be other apis that are better set up and can do what this one does along with other things.