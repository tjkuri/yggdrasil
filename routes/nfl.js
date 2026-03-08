// routes/nfl.js
const express = require("express");
const router = express.Router();

const roster = require("../services/nflverseRoster");
const stats = require("../services/nflverseStats");
const { listNflEvents, getEventOdds } = require("../services/theOddsApi");
const TEAM_BY_ABBR = require("../services/nflTeamNames");
const cache = require("../utils/cache");
const { isSamePlayer } = require("../utils/nameMatch");
const { computeMarketDispersion } = require("../utils/nflMath");

const EVENTS_CACHE_KEY = "odds:events:nfl";
const EVENTS_TTL_MS = 30 * 60 * 1000; // 30 min (free endpoint)
const NFL_PASS_YDS_MARKET = "player_pass_yds";
const NFL_PASS_YDS_REGION = "us";

const inflight = new Map(); // de-duplication for concurrent paid fetches per event

// ---- Shared helpers ----

async function getEventsCached() {
  const hit = cache.get(EVENTS_CACHE_KEY, EVENTS_TTL_MS);
  if (hit) return { data: hit.data, meta: hit.meta, cacheHit: true };
  const { data, headers } = await listNflEvents();
  const meta = {
    fetchedAt: new Date().toISOString(),
    headers: {
      x_last: headers["x-requests-last"],
      x_used: headers["x-requests-used"],
      x_remaining: headers["x-requests-remaining"],
    },
  };
  cache.set(EVENTS_CACHE_KEY, { data, meta });
  return { data, meta, cacheHit: false };
}

function findNextEventForTeam(events, fullTeamName) {
  const now = Date.now();
  const next = events
    .filter(e => e && (e.home_team === fullTeamName || e.away_team === fullTeamName))
    .map(e => ({ e, t: Date.parse(e.commence_time) }))
    .filter(x => !Number.isNaN(x.t) && x.t >= now)
    .sort((a, b) => a.t - b.t)[0];
  return next?.e || null;
}

/**
 * Fetch odds for an event with inflight de-duplication; stores result in cache.
 * Costs 1 API credit on a miss or explicit refresh.
 */
async function fetchAndCacheEventOdds(eventId, cacheKey) {
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  const p = (async () => {
    const { data, headers } = await getEventOdds(eventId, { market: NFL_PASS_YDS_MARKET, regions: NFL_PASS_YDS_REGION });
    const meta = {
      fetchedAt: new Date().toISOString(),
      headers: {
        x_last: headers["x-requests-last"],
        x_used: headers["x-requests-used"],
        x_remaining: headers["x-requests-remaining"],
      },
    };
    cache.set(cacheKey, { data, meta }); // no TTL → manual refresh only
    return { data, meta };
  })();
  inflight.set(cacheKey, p);
  try { return await p; } finally { inflight.delete(cacheKey); }
}

/**
 * Extract a QB's passing yards lines from a raw event odds blob.
 * Returns an array of bookmaker entries with paired Over/Under prices.
 */
function extractPlayerBooks(oddsBlob, playerName) {
  const books = [];
  for (const b of oddsBlob.bookmakers || []) {
    const market = (b.markets || []).find(mk => mk.key === NFL_PASS_YDS_MARKET);
    if (!market) continue;
    const outcomes = (market.outcomes || []).filter(o => isSamePlayer(o.description || o.name || "", playerName));
    if (!outcomes.length) continue;

    // Pair Over/Under by point value
    const byPoint = new Map();
    for (const o of outcomes) {
      const key = Number.isFinite(o.point) ? String(o.point) : "nopoint";
      const entry = byPoint.get(key) || {};
      const side = (o.name || "").toLowerCase();
      if (side === "over") entry.over = o;
      else if (side === "under") entry.under = o;
      entry.point = o.point;
      byPoint.set(key, entry);
    }
    const candidates = [...byPoint.values()].filter(e => typeof e.point === "number");
    const best = candidates.find(e => e.over && e.under) || candidates[0] || null;
    if (!best) continue;

    books.push({
      book: b.key,
      book_title: b.title,
      point: typeof best.point === "number" ? best.point : null,
      price_over: best.over?.price ?? null,
      price_under: best.under?.price ?? null,
      last_update: b.last_update || null,
    });
  }
  return books;
}

/** Resolve a player from the current-year roster by id or slug. */
async function resolvePlayer(playerId) {
  const year = new Date().getFullYear();
  const { players } = await roster.getQBs(year);
  const player = players.find(p => p.id === playerId) || players.find(p => p.slug === playerId);
  return { player, year };
}

// ---- Routes ----

router.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * GET /api/nfl/qbs?season=2025&active=true&startersOnly=false&limit=0
 */
router.get("/qbs", async (req, res) => {
  try {
    const nowYear = new Date().getFullYear();
    const season = Number(req.query.season) || nowYear;
    const activeOnly = req.query.active !== "false";
    const startersOnly = req.query.startersOnly === "true";
    const limit = Math.max(0, Number(req.query.limit) || 0);

    const rosterRows = await roster.loadRosterForSeasonPreferCurrent(season);
    let qbs = roster.extractQBs(rosterRows);

    if (activeOnly) qbs = qbs.filter(p => p.isActive);
    if (startersOnly) qbs = qbs.filter(p => p.isStarter);

    qbs.sort((a, b) => {
      if (a.isStarter !== b.isStarter) return a.isStarter ? -1 : 1;
      if (a.team_abbr !== b.team_abbr) return a.team_abbr.localeCompare(b.team_abbr);
      return a.name.localeCompare(b.name);
    });

    if (limit > 0) qbs = qbs.slice(0, limit);
    res.json({ season, players: qbs });
  } catch (err) {
    res.status(500).json({ error: "roster_error", message: err?.message || "Failed to load rosters." });
  }
});

/**
 * GET /api/nfl/qb/line?playerId=...&refresh=true
 * Returns the passing yards market odds for a single QB.
 */
router.get("/qb/line", async (req, res) => {
  try {
    const { playerId, refresh } = req.query;
    if (!playerId) return res.status(400).json({ error: "playerId is required" });

    const { player, year } = await resolvePlayer(playerId);
    if (!player) return res.status(404).json({ error: "Player not found in roster", year });

    const teamFull = TEAM_BY_ABBR[player.team_abbr];
    if (!teamFull) return res.status(400).json({ error: `Unknown team for abbr ${player.team_abbr}` });

    const { data: events } = await getEventsCached();
    const event = findNextEventForTeam(events, teamFull);
    if (!event) {
      return res.json({
        player: { id: player.id, name: player.name, team_abbr: player.team_abbr, team_name: teamFull },
        event: null,
        no_upcoming_game: true,
      });
    }

    const ODDS_CACHE_KEY = `odds:nfl:${event.id}:${NFL_PASS_YDS_MARKET}:${NFL_PASS_YDS_REGION}`;
    const cached = cache.get(ODDS_CACHE_KEY); // no TTL → manual-refresh only
    const wantsRefresh = String(refresh).toLowerCase() === "true";

    let oddsBlob, oddsMeta, cacheHit = false, seeded = false;
    if (cached && !wantsRefresh) {
      ({ data: oddsBlob, meta: oddsMeta } = cached); cacheHit = true;
    } else if (!cached) {
      ({ data: oddsBlob, meta: oddsMeta } = await fetchAndCacheEventOdds(event.id, ODDS_CACHE_KEY)); seeded = true;
    } else {
      ({ data: oddsBlob, meta: oddsMeta } = await fetchAndCacheEventOdds(event.id, ODDS_CACHE_KEY));
    }

    const books = extractPlayerBooks(oddsBlob, player.name);
    const dispersion = computeMarketDispersion(books);

    res.json({
      player: { id: player.id, name: player.name, team_abbr: player.team_abbr, team_name: teamFull },
      event: { id: event.id, home_team: event.home_team, away_team: event.away_team, commence_time: event.commence_time },
      market: NFL_PASS_YDS_MARKET,
      region: NFL_PASS_YDS_REGION,
      ...dispersion,
      book_count: books.length,
      books,
      as_of: oddsMeta?.fetchedAt || null,
      cache: {
        hit: cacheHit,
        seeded_on_miss: seeded,
        key: ODDS_CACHE_KEY,
        age_minutes: oddsMeta?.fetchedAt ? Math.round((Date.now() - Date.parse(oddsMeta.fetchedAt)) / 60000) : null,
        needs_refresh: false,
      },
      credits: oddsMeta?.headers || null,
    });
  } catch (err) {
    console.error("qb/line error:", err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json({ error: "Failed to fetch QB line", detail: err?.response?.data || err.message });
  }
});

/**
 * GET /api/nfl/qb/passing-yards?playerId=...&line=246.5&minAttempts=10
 * Returns career/last/current season passing yards distributions.
 */
router.get("/qb/passing-yards", async (req, res) => {
  try {
    const { playerId } = req.query;
    const line = req.query.line != null ? Number(req.query.line) : null;
    const minAttempts = req.query.minAttempts != null ? Number(req.query.minAttempts) : 10;
    if (!playerId) return res.status(400).json({ error: "playerId is required" });

    const { player, year } = await resolvePlayer(playerId);
    if (!player) return res.status(404).json({ error: "Player not found in roster", year });

    const teamFull = TEAM_BY_ABBR[player.team_abbr] || player.team_abbr;
    const current = year, last = year - 1;

    const [currRows, lastRows] = await Promise.all([
      stats.loadQBPassYardsBySeasons(player, [current]),
      stats.loadQBPassYardsBySeasons(player, [last]),
    ]);

    const scopes = await stats.buildScopedDistributions(player, { currRows, lastRows }, { current, last, minAttempts, line });

    res.json({
      player: { id: player.id, name: player.name, team_abbr: player.team_abbr, team_name: teamFull },
      line: line ?? null,
      attempts_threshold: minAttempts,
      scopes,
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    console.error("qb/passing-yards error:", err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json({ error: "Failed to build passing-yards distributions", detail: err?.response?.data || err.message });
  }
});

/**
 * GET /api/nfl/qb/analysis?playerId=...&refreshOdds=true|false&minAttempts=10[&line=246.5]
 * Combined odds + distributions in a single call.
 */
router.get("/qb/analysis", async (req, res) => {
  try {
    const { playerId } = req.query;
    if (!playerId) return res.status(400).json({ error: "playerId is required" });

    const wantsRefresh = String(req.query.refreshOdds).toLowerCase() === "true";
    const minAttempts = req.query.minAttempts != null ? Number(req.query.minAttempts) : 10;
    const lineOverride = req.query.line != null ? Number(req.query.line) : null;

    const { player, year } = await resolvePlayer(playerId);
    if (!player) return res.status(404).json({ error: "Player not found in roster", year });

    const teamFull = TEAM_BY_ABBR[player.team_abbr] || player.team_abbr;

    // --- Odds (manual-refresh policy) ---
    const { data: events } = await getEventsCached();
    const event = findNextEventForTeam(events, teamFull);

    let oddsPayload;
    if (!event) {
      oddsPayload = {
        market: NFL_PASS_YDS_MARKET, region: NFL_PASS_YDS_REGION,
        consensus_line: null, book_count: 0, books: [], as_of: null,
        cache: { hit: true, seeded_on_miss: false, age_minutes: null, needs_refresh: false },
        credits: null, no_upcoming_game: true,
      };
    } else {
      const ODDS_CACHE_KEY = `odds:nfl:${event.id}:${NFL_PASS_YDS_MARKET}:${NFL_PASS_YDS_REGION}`;
      const cached = cache.get(ODDS_CACHE_KEY);

      let oddsBlob, oddsMeta, cacheHit = false, seeded = false;
      if (cached && !wantsRefresh) {
        ({ data: oddsBlob, meta: oddsMeta } = cached); cacheHit = true;
      } else if (!cached) {
        ({ data: oddsBlob, meta: oddsMeta } = await fetchAndCacheEventOdds(event.id, ODDS_CACHE_KEY)); seeded = true;
      } else {
        ({ data: oddsBlob, meta: oddsMeta } = await fetchAndCacheEventOdds(event.id, ODDS_CACHE_KEY));
      }

      const books = extractPlayerBooks(oddsBlob, player.name);
      const dispersion = computeMarketDispersion(books);

      oddsPayload = {
        market: NFL_PASS_YDS_MARKET, region: NFL_PASS_YDS_REGION,
        ...dispersion,
        book_count: books.length,
        books,
        as_of: oddsMeta?.fetchedAt || null,
        cache: {
          hit: cacheHit, seeded_on_miss: seeded, key: ODDS_CACHE_KEY,
          age_minutes: oddsMeta?.fetchedAt ? Math.round((Date.now() - Date.parse(oddsMeta.fetchedAt)) / 60000) : null,
          needs_refresh: false,
        },
        credits: oddsMeta?.headers || null,
      };
    }

    // --- Distributions ---
    const lineForAnalysis = lineOverride ?? oddsPayload?.consensus_line ?? null;
    const current = year, last = year - 1;

    const [currRows, lastRows] = await Promise.all([
      stats.loadQBPassYardsBySeasons(player, [current]),
      stats.loadQBPassYardsBySeasons(player, [last]),
    ]);

    const scopes = await stats.buildScopedDistributions(player, { currRows, lastRows }, { current, last, minAttempts, line: lineForAnalysis });

    return res.json({
      player: { id: player.id, name: player.name, team_abbr: player.team_abbr, team_name: teamFull },
      event: event ? { id: event.id, home_team: event.home_team, away_team: event.away_team, commence_time: event.commence_time } : null,
      odds: oddsPayload,
      distributions: { attempts_threshold: minAttempts, scopes },
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    console.error("qb/analysis error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({ error: "Failed to build QB analysis", detail: err?.response?.data || err.message });
  }
});


module.exports = router;
