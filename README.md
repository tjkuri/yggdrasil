# Yggdrasil
Backend to [Mimir](https://github.com/tjkuri/mimir).

Node.js/Express API on port 3001. Pulls from third-party sports APIs, does the stat aggregation and analysis, and hands structured data to the frontend so the frontend can stay dumb.

## What it does

**NBA** — Fetches today's scoreboard from ESPN (no key, unofficial API), pulls the last 10 completed regular-season games per team and runs an O/D split projection with exponential recency weighting, then layers in DraftKings odds from The Odds API. OT games are stripped to regulation scores before model input so inflated totals don't skew averages. Returns enriched games with recommendation, confidence, win probability, EV, and line movement.

**NFL** — QB passing yards analysis. Roster from nflverse CSVs, odds from The Odds API, historical distributions built from nflverse weekly stats. The `/qb/analysis` endpoint combines all three.

## Further Reading
Have a [Journal.md](JOURNAL.md) where I try to keep track of lessons learned and design decisions. Obviously a Jira-like system would be more professional but it's just me.

## Running it

```bash
node server.js   # port 3001 (or $PORT)
```

### .env
Only The Odds API key is required. NBA game data comes from the ESPN unofficial API (no key needed).

```bash
ODDS_API_KEY=<KEY>
ODDS_HOST=https://api.the-odds-api.com   # optional, this is the default
ODDS_REFRESH_MODE=manual                  # prevents auto-expiry of paid odds calls
```
