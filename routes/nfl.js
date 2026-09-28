// routes/nfl.js
const express = require("express");
const router = express.Router();

const roster = require("../services/nflverseRoster");
const stats = require("../services/nflverseStats");
const defense = require("../services/nflDefense");
const nflSchedule = require("../services/nflSchedule");
const nflLogger = require("../services/nflLogger");
const { listNflEvents, getEventOdds } = require("../services/theOddsApi");
const TEAM_BY_ABBR = require("../services/nflTeamNames");
const cache = require("../utils/cache");
const { isSamePlayer } = require("../utils/nameMatch");
const { computeMarketDispersion, computeQbVerdict } = require("../utils/nflMath");
const NFL_CFG = require("../config/nfl");

const TEAM_NAME_TO_ABBR = Object.fromEntries(
  Object.entries(TEAM_BY_ABBR).map(([abbr, name]) => [name, abbr])
);

const espnNflApi = require("../services/espnNflApi");

/** Given an event and a team's own full name, resolve the opponent's abbreviation. */
function findOpponentAbbr(event, ownTeamFull) {
  if (!event) return null;
  const oppFull = event.home_team === ownTeamFull ? event.away_team : event.home_team;
  return TEAM_NAME_TO_ABBR[oppFull] || null;
}

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

/** Stable, order-independent cache key for "the odds-api event for this team pair," so a
 * matchup stays resolvable after it drops off the free /events list — confirmed live: that
 * list doesn't retain Final games, it replaces them with next week's slate. No TTL: persists
 * exactly as long as the odds blobs themselves already do (manual-refresh-only convention). */
function matchupCacheKey(teamAFull, teamBFull) {
  return `odds:nfl:matchup-event:${[teamAFull, teamBFull].sort().join("|")}`;
}
function rememberOddsEvent(event) {
  if (!event) return;
  cache.set(matchupCacheKey(event.home_team, event.away_team), event);
}
function recallOddsEvent(teamAFull, teamBFull) {
  const remembered = cache.get(matchupCacheKey(teamAFull, teamBFull)); // no ttl arg -> never expires
  if (!remembered) return null;
  // Refuse a remembered event that's actually in the future — happens when the same two teams
  // play twice in a season (division rivals) and the later meeting overwrote the earlier one's
  // memory. The live list is always tried first, so recall is only reached when it has no
  // match — unusual for a genuinely upcoming game, but the norm for an already-Final one. Bias
  // recall toward "the game that already happened."
  if (Date.parse(remembered.commence_time) > Date.now()) return null;
  return remembered;
}

/** Resolve the event for a SPECIFIC matchup (past, live, or future) — unlike
 * findNextEventForTeam, this doesn't filter by time, since the caller already knows
 * exactly which game it means (from /api/nfl/week). */
function findEventForMatchup(events, ownTeamFull, opponentAbbr) {
  const oppFull = TEAM_BY_ABBR[opponentAbbr];
  if (!oppFull) return null;
  const live = events.find(e =>
    e && ((e.home_team === ownTeamFull && e.away_team === oppFull) ||
    (e.away_team === ownTeamFull && e.home_team === oppFull))
  );
  if (live) { rememberOddsEvent(live); return live; }
  // Live list has no match — most likely this game already went Final and was replaced by
  // next week's slate. Fall back to whatever we remembered from an earlier lookup this week.
  return recallOddsEvent(ownTeamFull, oppFull) || null;
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
 * GET /api/nfl/week
 * This week's full schedule with each side's resolved starting QB (via ESPN's own
 * depth chart) and whether that QB already has a DraftKings market cached. Never
 * triggers a fresh paid odds fetch — see Global Constraints.
 */
router.get("/week", async (req, res) => {
  try {
    const year = new Date().getFullYear();
    const [{ players: allQBs }, { data: oddsEvents }, scoreboard] = await Promise.all([
      roster.getQBs(year),
      getEventsCached(),
      espnNflApi.fetchWeekScoreboard(),
    ]);

    async function resolveSide(side) {
      if (!side) return null;
      const chart = await espnNflApi.fetchDepthChart(side.espn_team_id);
      const starterName = chart[0]?.displayName || null;
      const match = starterName
        ? allQBs.find(p => p.team_abbr === side.abbr && isSamePlayer(p.name, starterName))
        : null;

      let marketPosted = false;
      if (match) {
        const teamFull = TEAM_BY_ABBR[side.abbr];
        const oddsEvent = teamFull
          ? oddsEvents.find(e => e.home_team === teamFull || e.away_team === teamFull)
          : null;
        if (oddsEvent) {
          rememberOddsEvent(oddsEvent); // populate matchup memory before this game can go Final and drop off the free events list
          const key = `odds:nfl:${oddsEvent.id}:${NFL_PASS_YDS_MARKET}:${NFL_PASS_YDS_REGION}`;
          const cached = cache.get(key); // no TTL → never expires, matches existing odds-cache convention
          if (cached) {
            const books = extractPlayerBooks(cached.data, match.name);
            marketPosted = books.some(b => b.book === "draftkings" && typeof b.point === "number");
          }
        }
      }

      return {
        abbr: side.abbr,
        name: side.name,
        score: side.score,
        qb: match ? { id: match.id, slug: match.slug, name: match.name, market_posted: marketPosted } : null,
      };
    }

    const games = await Promise.all(scoreboard.map(async g => ({
      espn_event_id: g.id,
      commence_time: g.commence_time,
      state: g.state,
      short_detail: g.short_detail,
      home: await resolveSide(g.home),
      away: await resolveSide(g.away),
    })));

    res.json({ season: year, games });
  } catch (err) {
    console.error("nfl/week error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to build week schedule", detail: err.message });
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
    const opponentAbbrParam = req.query.opponentAbbr || null;
    const event = opponentAbbrParam
      ? findEventForMatchup(events, teamFull, opponentAbbrParam)
      : findNextEventForTeam(events, teamFull);

    const commenceMs = event ? Date.parse(event.commence_time) : NaN;
    const isPastKickoff = !!(event && (Number.isNaN(commenceMs) || commenceMs < Date.now()));
    const effectiveWantsRefresh = wantsRefresh && !isPastKickoff; // never allow refresh after kickoff

    let oddsPayload;
    if (!event) {
      oddsPayload = {
        market: NFL_PASS_YDS_MARKET, region: NFL_PASS_YDS_REGION,
        consensus_line: null, book_count: 0, books: [], as_of: null,
        cache: { hit: true, seeded_on_miss: false, age_minutes: null, needs_refresh: false },
        credits: null, no_upcoming_game: true, market_captured: false,
      };
    } else {
      const ODDS_CACHE_KEY = `odds:nfl:${event.id}:${NFL_PASS_YDS_MARKET}:${NFL_PASS_YDS_REGION}`;
      const cached = cache.get(ODDS_CACHE_KEY);

      if (isPastKickoff && !cached) {
        // Never seed a fresh paid fetch for a game that's already started — the market's
        // closed. Distinct from no_upcoming_game: this game IS real, we just never
        // captured its market before kickoff.
        oddsPayload = {
          market: NFL_PASS_YDS_MARKET, region: NFL_PASS_YDS_REGION,
          consensus_line: null, book_count: 0, books: [], as_of: null,
          cache: { hit: false, seeded_on_miss: false, age_minutes: null, needs_refresh: false },
          credits: null, no_upcoming_game: false, market_captured: false,
        };
      } else {
        let oddsBlob, oddsMeta, cacheHit = false, seeded = false;
        if (cached && !effectiveWantsRefresh) {
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
          no_upcoming_game: false, market_captured: true,
        };
      }
    }

    // --- Market basis: prefer DraftKings for the line and the edge math, since that's what
    // this is actually used against; fall back to consensus (never silently) when DK isn't
    // quoting this player yet. An explicit ?line= override still wins over both.
    const dkBook = (oddsPayload?.books || []).find(
      b => b.book === "draftkings" && typeof b.point === "number" && b.price_over != null && b.price_under != null
    );
    const marketBasis = dkBook
      ? { used: "draftkings", requested: "draftkings", fell_back: false }
      : { used: "consensus", requested: "draftkings", fell_back: (oddsPayload?.books?.length || 0) > 0 };
    const booksForVerdict = dkBook ? [dkBook] : oddsPayload?.books;

    // --- Distributions ---
    const lineForAnalysis = lineOverride ?? (dkBook ? dkBook.point : oddsPayload?.consensus_line) ?? null;
    const current = year, last = year - 1;

    const [currRows, lastRows] = await Promise.all([
      stats.loadQBPassYardsBySeasons(player, [current]),
      stats.loadQBPassYardsBySeasons(player, [last]),
    ]);

    // --- Opponent matchup adjustment ---
    const opponentAbbr = findOpponentAbbr(event, teamFull);
    let matchup = null;
    if (opponentAbbr) {
      const profiles = await defense.getDefenseProfiles({ current, prior: last });
      const profile = profiles[opponentAbbr];
      if (profile) {
        matchup = {
          opponent_abbr: opponentAbbr,
          opponent_name: TEAM_BY_ABBR[opponentAbbr] || opponentAbbr,
          ...profile,
        };
      }
    }

    const scopes = await stats.buildScopedDistributions(
      player, { currRows, lastRows },
      { current, last, minAttempts, line: lineForAnalysis, matchupFactor: matchup?.matchup_factor ?? 1.0 }
    );

    // --- Verdict: one recommendation, from whichever scope has the best usable sample ---
    // Same fallback order the frontend already uses to pick a default scope tab (last season
    // is a full, stable sample; career risks diluting with very old/irrelevant seasons; current
    // season is last resort since early on it's 1-3 games).
    const verdictScopeName =
      (scopes.last_season?.n || 0) > 0 ? "last_season" :
      (scopes.career?.n || 0) > 0 ? "career" :
      "current_season";
    const verdict = {
      scope_used: verdictScopeName,
      ...computeQbVerdict(scopes[verdictScopeName], lineForAnalysis, booksForVerdict, NFL_CFG),
    };

    // --- Log prediction snapshot (fire-and-forget, write-once by season+week+player) ---
    if (opponentAbbr && event) {
      const homeAbbr = TEAM_NAME_TO_ABBR[event.home_team];
      const awayAbbr = TEAM_NAME_TO_ABBR[event.away_team];
      nflSchedule.getWeekForMatchup({ homeAbbr, awayAbbr, commenceTime: event.commence_time })
        .then(result => {
          if (!result) {
            console.warn("[nflLogger] skipped: no schedule match for", { homeAbbr, awayAbbr, commenceTime: event.commence_time });
            return;
          }
          return nflLogger.logPredictionIfNew({
            season: result.season, week: result.week, player, opponentAbbr,
            line: lineForAnalysis, scopeUsed: verdictScopeName, verdict,
            adjustedMean: scopes[verdictScopeName]?.mean ?? null,
          });
        })
        .catch(err => console.error("[nflLogger] failed:", err?.message || err));
    }

    return res.json({
      player: { id: player.id, name: player.name, team_abbr: player.team_abbr, team_name: teamFull },
      event: event ? { id: event.id, home_team: event.home_team, away_team: event.away_team, commence_time: event.commence_time } : null,
      odds: oddsPayload,
      odds_locked: isPastKickoff,
      line: lineForAnalysis,
      market_basis: marketBasis,
      matchup,
      verdict,
      distributions: { attempts_threshold: minAttempts, scopes },
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    console.error("qb/analysis error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({ error: "Failed to build QB analysis", detail: err?.response?.data || err.message });
  }
});


module.exports = router;
