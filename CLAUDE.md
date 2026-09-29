# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Yggdrasil is a Node.js/Express backend for [Mimir](https://github.com/tjkuri/mimir), a sports betting analytics frontend. It aggregates data from multiple third-party sports APIs, performs statistical analysis, and exposes a REST API on port 3001.

The sibling frontend project (Mimir) lives at `../mimir` and runs on port 3000.

## Commands

```bash
node server.js                          # Start server (port 3001, or $PORT)
```

Backtest and analysis live in the sibling repo [Huginn](../huginn) (`python scripts/run_backtest.py`).

No test suite is configured yet.

## Architecture

```
server.js             # Express entry point, CORS (localhost:3000 only), route mounting
routes/
  nba.js              # GET /api/nba/totals — today's games with my line vs DK odds
  nfl.js              # GET /api/nfl/qbs, /week, /qb/line, /qb/passing-yards, /qb/analysis
services/
  espnNbaApi.js       # NBA scoreboard + team schedules via ESPN unofficial API (no key, 5m/1h/24h TTL); fetchScoreboardForDate(dateStr) + fetchTodayScoreboard() + fetchLastNTeamGames (regulation-only) + fetchLastNTeamGamesTotal (full incl. OT) + fetchGameSummary
  espnNflApi.js       # NFL scoreboard + depth charts + boxscores via ESPN unofficial API (no key, 5m/12h/12h TTL); fetchWeekScoreboard() + fetchDepthChart(espnTeamId) + fetchGameSummary(espnEventId) + normalizeEspnAbbr (ESPN's LAR/WSH -> this codebase's LA/WAS — confirmed live as the only 2 of 32 teams that differ)
  theOddsApi.js       # Sportsbook odds (NBA totals, NFL passing yards) via The Odds API
  nbaLogger.js        # Write/update file-based NBA records: writeResultsForDate, writePredictionsForDate (write-once snapshot), backfillLastNDays
  nflverseRoster.js   # NFL roster CSVs from nflverse GitHub releases (12h TTL cache)
  nflverseStats.js    # NFL weekly player stats CSVs from nflverse (12h TTL cache); exports buildScopedDistributions
  nflDefense.js       # Opponent-adjustment factors per team: pass_ypa_factor + rush_stop_factor ("funnel"), recency-weighted + shrunk toward league avg
  nflTeamNames.js     # Static lookup: team abbreviation → full name
scripts/
  backfill.js         # One-off backfill helper
utils/
  cache.js            # In-memory Map with TTL (get/set/del/clear)
  cache/              # File-based JSON cache for NBA odds/mylines (keyed by date)
  utils.js            # Sports day helpers (getSportsDayEST — rolls over at 4AM ET, getSportsDayStartISO, getSportsDayEndISO)
  nbaMath.js          # NBA math helpers: weightedMean, weightedVariance, normalCDF
  nflMath.js          # NFL stats helpers: mean, median, quantile, summarize, computeMarketDispersion, buildHistogram,
                      #   americanToImpliedProb, devigFairProbOver, wilsonInterval, computeQbVerdict
  nameMatch.js        # Player name normalization and fuzzy-matching (isSamePlayer) — single source of truth
config/
  nba.js              # NBA model constants: SAMPLE_SIZE, LAMBDA, HOME_BOOST, Z thresholds, VIG rates
  nfl.js              # NFL opponent-adjustment + verdict constants: recency weights, shrinkage K per factor, volume
                      #   dampening exponent, Wilson-interval z and confidence margin
```

## Environment Variables (.env)

```
ODDS_API_KEY      # The Odds API (paid, credit-limited)
ODDS_HOST         # https://api.the-odds-api.com
ODDS_REFRESH_MODE # "manual" = never auto-refresh paid odds
```

## Key Patterns

**Caching layers** — The Odds API costs credits per call; guard every paid call:
- Free events list: 30m in-memory TTL
- Paid odds blobs: manual-refresh only (never auto-expire)
- Rosters/stats CSVs: 12h in-memory TTL
- NBA odds/mylines: file-based JSON in `cache/YYYY-MM-DD-*.json`
- In-flight deduplication: a Promise Map prevents duplicate concurrent fetches

**Player ID resolution** — NFL players are identified by GSIS ID > PFR ID > slug (`last-first`). The `/api/nfl/qbs` endpoint returns both; all QB endpoints accept either.

**Name matching** — Bookmaker player names (e.g. "P. Mahomes") are matched against roster names using `isSamePlayer()` in `utils/nameMatch.js`. Both `routes/nfl.js` and `services/nflverseStats.js` import from there — do not duplicate this logic.

**NFL data flow for `/qb/analysis`** (the main combined endpoint):
1. Load roster CSV (cached) → resolve player
2. Resolve the event via `findEventForMatchup` (optional `opponentAbbr` query param resolves a *specific* matchup — past, live, or future) or `findNextEventForTeam` (default when `opponentAbbr` is omitted — next future event only, the original behavior)
3. Compute `isPastKickoff` from the resolved event's `commence_time`, exposed as top-level `odds_locked`. Check odds cache; seed from the paid API on a miss (1 credit) — **unless** `odds_locked` is true, in which case a never-captured market stays uncaptured and `refreshOdds=true` is silently ignored (the market's closed, there's nothing fresher to fetch). `odds.market_captured: false` means "this game is real but its market was never grabbed before kickoff" — distinct from the pre-existing `odds.no_upcoming_game` ("no game scheduled for this team at all").
4. Resolve opponent abbr from the event, look up their `matchup_factor` via `nflDefense.getDefenseProfiles()`
5. Load weekly stats CSVs → build career/last/current season distributions, rescaled by the opponent's `matchup_factor` (each scope also returns `raw_mean` and `raw_p_over`/`raw_p_under`, unadjusted, alongside the adjusted `mean`/`p_over`/`p_under`)
6. Pick the authoritative scope (last season → career → current season fallback — same order the frontend uses to pick its default tab). Pick the pricing basis: DraftKings if it's quoting both sides of the market, else the full consensus book set (`market_basis: { used, requested, fell_back }` in the response). Run `computeQbVerdict()` against that scope and basis for a single OVER/UNDER/NO_BET `recommendation`, plus an always-populated `lean` field that names which way the model reads even when `recommendation` collapses to `NO_BET`.
7. If the caller passes `espnEventId` (opt-in — the frontend already has it from `/api/nfl/week`, so this route trusts it rather than re-deriving the game) and that ESPN game's state is `post` (Final), fetch its boxscore (`espnNflApi.fetchGameSummary`) and compare the QB's actual passing yards to the line and verdict `lean` → top-level `actual_result: { yards, outcome: "hit"|"miss" }` (`null` when omitted or not yet Final).
8. Return player + event + odds + `odds_locked` + `line` (the line actually used for the verdict — DK's or the fallback consensus) + `market_basis` + matchup + verdict + `actual_result` + distributions + timestamp

**Matchup-event resolution and a real Odds API quirk (`routes/nfl.js`)** — The Odds API's free `/events` endpoint doesn't just eventually drop a Final game, it replaces the whole slate with next week's games the moment a game goes Final. That silently broke `opponentAbbr`-based matchup lookup for any already-Final game (live-list search comes up empty). Fixed with a persisted team-pair → event memory, next to `findEventForMatchup`:
- `matchupCacheKey(teamAFull, teamBFull)` — order-independent key, no TTL (same manual-refresh convention as the odds blobs themselves)
- `rememberOddsEvent(event)` — called every time an event is resolved live, both inside `/qb/analysis` and proactively by `GET /api/nfl/week` on every schedule load, so a game is remembered well before it can go Final and vanish from the free list
- `recallOddsEvent(teamAFull, teamBFull)` — the fallback once the live list has no match; refuses to return a remembered event whose `commence_time` is still in the future, guarding against a division-rival rematch (same two teams meet twice in a season) overwriting an earlier Final game's memory with the not-yet-played one

**`GET /api/nfl/week`** — this week's full schedule via `espnNflApi.fetchWeekScoreboard()`. For each side, resolves the starting QB from ESPN's own depth chart (`fetchDepthChart`, first athlete listed) matched back to the roster via `isSamePlayer`, and reports `qb.market_posted` by checking — never seeding — the existing odds cache for any cached DraftKings line (point value present, regardless of whether both sides are quoted — a one-sided line still counts; a cache miss just means `false`, never a paid fetch). Also calls `rememberOddsEvent` for every event where it successfully resolves a side's starting QB, proactively populating the matchup memory described above.

**Opponent adjustment (`nflDefense.js`)** — two raw ratios per team, each shrunk toward 1.0, combined into `matchup_factor`:
- `shrink(raw, n, k) = (n·raw + k·1.0) / (n + k)` — pulls a factor toward league-average (1.0) when its weighted sample `n` is thin, controlled by `SHRINK_K_PASS`/`SHRINK_K_RUSH`.
- `pass_ypa_factor = shrink(teamYPA / leagueYPA, n_pass, SHRINK_K_PASS)`, where `teamYPA = pass yds allowed / attempts faced`. Efficiency, not raw yards allowed — the DVOA-style approach — so a defense that faces heavy volume isn't mistaken for a bad pass defense.
- `rush_stop_factor = shrink(leagueYPC / teamYPC, n_rush, SHRINK_K_RUSH)`. A stout run defense pushes opponents to throw more (the "pass funnel" effect fantasy sites publish weekly); real in the data (corr ≈ 0.30 with QB attempts faced in 2025) but weaker than the efficiency signal.
- `attempts_factor = rush_stop_factor ^ VOLUME_DAMPEN_EXP` — the funnel signal dampened before folding in, since it's weaker than the pass-efficiency signal.
- `matchup_factor = pass_ypa_factor × attempts_factor`.
- Both `teamYPA`/`teamYPC` and each factor's weighted sample `n` blend current + prior season (recency-weighted via `RECENCY_WEIGHT_CURRENT`/`_PRIOR`), and `n` is accumulated by **distinct-game count**, not row count — a rushing factor naturally has several ball-carrier rows per game (RB/WR/QB scrambles) where the passing factor has ~one qualifying passer row, so aggregation counts must dedupe on `game_id` or the two factors' apparent sample sizes go out of sync.
- Applied as a single rescale: `adjusted_yards = raw_yards × matchup_factor` across every historical game in every scope — not a filter, so sample size (`n`) is preserved.

**Verdict (`computeQbVerdict` in `nflMath.js`)** — one lean per QB, deliberately without a dollar EV:
- "Edge" = model probability (the scope's own empirical `p_over`/`p_under`) minus the market's **de-vigged** fair probability (`devigFairProbOver` — proportional method, averaged across every book quoting both sides). Comparing to a vig-included price overstates how much the market actually disagrees with the model.
- Confidence comes from a **Wilson score interval** (`wilsonInterval`) on the model's own probability, not z-score magnitude — z can look confident off a tiny sample precisely because a small sample produces artificially tight variance; Wilson widens correctly with small n.
- No dollar EV: tested against live data before shipping and a HIGH-confidence, 28.6%-edge, +$47 read came back for a QB whose market line was priced at ~50% fair by five books. That's not a real market miss in a market this liquid — it's this model (season average + opponent multiplier only, no game-script/weather/injury signal) disagreeing with a much better-informed number. A dollar figure would have implied a confidence the model can't back up. Full writeup in JOURNAL.md (2026-09-26, "cont'd").

**NBA data flow for `/api/nba/totals`**:
1. Fetch today's scoreboard via `fetchTodayScoreboard()` (→ `fetchScoreboardForDate(getSportsDayEST())`), which passes `?dates=YYYYMMDD` to pin to today's slate. Auto-persist results as fire-and-forget via `nbaLogger.writeResultsForDate` (updates `cache/YYYY-MM-DD-nba-results.json`; locks records once STATUS_FINAL).
2. For each game, fetch last 10 completed regular-season games per team via `fetchLastNTeamGames` (1h TTL). OT games are detected via `shortDetail.includes('OT')`; if detected, `fetchGameSummary(eventId)` (24h cache) sums only the first 4 quarters. Model always trains on regulation-only scores.
3. Compute projection via O/D split model (`computeMyLine`): recency-weighted offense/defense averages (λ=0.96), home-court adjustment (derived from venue splits if ≥4 each, else flat +1.5). Propagate weighted variance through the formula to get `sdTotal`.
4. Derive `z_score = discrepancy / sdTotal`, map to `confidence` (HIGH/MEDIUM/LOW), compute vig-adjusted `expected_value` and `win_probability`. Gate `recommendation` on `|z| ≥ 0.5` and `EV > 0`; returns `NO_BET` otherwise.
5. Fetch DraftKings odds from The Odds API (file-cached daily in `cache/YYYY-MM-DD-nba-total-odds.json`)
   - Opening snapshot saved to `*-odds-open.json` on first fetch — never overwritten, used for line movement
   - `?refreshOdds=true` re-fetches live odds and merges with cache (preserves lines for finished games)
   - My-lines cached as `cache/YYYY-MM-DD-nba-model-inputs.json` (stores raw game splits with regulation-only scores, not totals)
   - Once both odds-open and model-inputs exist, `nbaLogger.writePredictionsForDate` writes a write-once predictions snapshot (`cache/YYYY-MM-DD-nba-predictions.json`, model_version v3) with opening line, z_score, confidence, recommendation, EV, and a v1_line baseline (mean of last 3 full game totals via `fetchLastNTeamGamesTotal`)
6. Return enriched games array with `line_movement: { from, to }` when DK line has shifted; also includes `proj_home`, `proj_away`, `sd_total`, `components`

## Current API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/nba/totals` | Today's NBA games with projected total, DK odds, confidence, EV, win probability, recommendation |
| GET | `/api/nba/backfill` | Backfill results + predictions for last 3 sports days (idempotent) |
| GET | `/api/nfl/health` | Health check |
| GET | `/api/nfl/qbs` | NFL QB roster list (supports `season`, `active`, `startersOnly`, `limit`) |
| GET | `/api/nfl/week` | This week's schedule with each side's resolved starting QB and DK market-posted flag; never triggers a paid odds fetch |
| GET | `/api/nfl/qb/line` | Passing yards market odds for one QB (`playerId`, `refresh`) |
| GET | `/api/nfl/qb/passing-yards` | Historical passing yards distributions (`playerId`, `line`, `minAttempts`) |
| GET | `/api/nfl/qb/analysis` | Combined odds + opponent-adjusted distributions + one-scope verdict (`playerId`, `refreshOdds`, `minAttempts`, `line`, `opponentAbbr`, `espnEventId`) |
