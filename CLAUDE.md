# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Yggdrasil is a Node.js/Express backend for [Mimir](https://github.com/tjkuri/mimir), a sports betting analytics frontend. It aggregates data from multiple third-party sports APIs, performs statistical analysis, and exposes a REST API on port 3001.

The sibling frontend project (Mimir) lives at `../mimir` and runs on port 3000.

## Commands

```bash
node server.js        # Start server (port 3001, or $PORT)
```

No test suite is configured yet.

## Architecture

```
server.js             # Express entry point, CORS (localhost:3000 only), route mounting
routes/
  nba.js              # GET /api/nba/totals — today's games with my line vs DK odds
  nfl.js              # GET /api/nfl/qbs, /qb/line, /qb/passing-yards, /qb/analysis
services/
  espnNbaApi.js       # NBA scoreboard + team schedules via ESPN unofficial API (no key, 5m/1h TTL)
  theOddsApi.js       # Sportsbook odds (NBA totals, NFL passing yards) via The Odds API
  nflverseRoster.js   # NFL roster CSVs from nflverse GitHub releases (12h TTL cache)
  nflverseStats.js    # NFL weekly player stats CSVs from nflverse (12h TTL cache); exports buildScopedDistributions
  nflTeamNames.js     # Static lookup: team abbreviation → full name
utils/
  cache.js            # In-memory Map with TTL (get/set/del/clear)
  cache/              # File-based JSON cache for NBA odds/mylines (keyed by date)
  utils.js            # EST timezone helpers (getToday10AMEST, getYesterdayEST, etc.)
  nflMath.js          # NFL stats helpers: mean, median, quantile, summarize, computeMarketDispersion, buildHistogram
  nameMatch.js        # Player name normalization and fuzzy-matching (isSamePlayer) — single source of truth
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
2. Fetch next team event (free endpoint, 30m cache)
3. Check odds cache; seed from paid API on miss (1 credit)
4. Load weekly stats CSVs → build career/last/current season distributions
5. Return player + event + odds + distributions + timestamp

**NBA data flow for `/api/nba/totals`**:
1. Fetch today's scoreboard from ESPN (free, no key, 5-min in-memory TTL)
2. For each game, fetch last 3 completed regular-season games per team via ESPN team schedule (1h TTL)
3. Compute `my_line` (mean of 6 totals), `discrepancy`, `recommendation`, `record` in the backend
4. Fetch DraftKings odds from The Odds API (file-cached daily)
5. Return enriched games array — frontend just renders

## Current API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/nba/totals` | Today's NBA games with my line + DK odds |
| GET | `/api/nfl/health` | Health check |
| GET | `/api/nfl/qbs` | NFL QB roster list (supports `season`, `active`, `startersOnly`, `limit`) |
| GET | `/api/nfl/qb/line` | Passing yards market odds for one QB (`playerId`, `refresh`) |
| GET | `/api/nfl/qb/passing-yards` | Historical passing yards distributions (`playerId`, `line`, `minAttempts`) |
| GET | `/api/nfl/qb/analysis` | Combined odds + distributions (`playerId`, `refreshOdds`, `minAttempts`, `line`) |
