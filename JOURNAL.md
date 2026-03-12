# Journal
Need a file to keep track of why I chose to so certain things.
The front end repo mimir has its own version of this, trying to keep notes in the repo that best makes sense but occasionally some things are relavent to both (e.g., the addition of a new stat to track or a new sport to include, that overarching kind of thing will probably be thrown into Mimir's Journal.md)

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