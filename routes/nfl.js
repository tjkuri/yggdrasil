// routes/nfl.js
const express = require("express");
const router = express.Router();

const { loadRosterForSeasonPreferCurrent, extractQBs } = require("../services/nflverseRoster");
const { listNflEvents, getEventOdds } = require("../services/theOddsApi");
const TEAM_BY_ABBR = require("../services/nflTeamNames");
const roster = require("../services/nflverseRoster");
const cache = require("../utils/cache");

router.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * GET /api/nfl/qbs?season=2025&active=true&startersOnly=false&limit=0
 * - season: defaults to current year
 * - active: filter to active QBs (default true)
 * - startersOnly: only rows we think are starters (default false)
 * - limit: cap the number returned (0 = no cap)
 */
router.get("/qbs", async (req, res) => {
  try {
    const nowYear = new Date().getFullYear();
    const season = Number(req.query.season) || nowYear;
    const activeOnly = req.query.active !== "false";
    const startersOnly = req.query.startersOnly === "true";
    const limit = Math.max(0, Number(req.query.limit) || 0);

    const rosterRows = await loadRosterForSeasonPreferCurrent(season);
    let qbs = extractQBs(rosterRows);

    if (activeOnly) qbs = qbs.filter((p) => p.isActive);
    if (startersOnly) qbs = qbs.filter((p) => p.isStarter);

    // Sort: starters first, then by team, then name
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


// ---- helpers & cache keys ----
const EVENTS_CACHE_KEY = "odds:events:nfl";
const EVENTS_TTL_MS = 30 * 60 * 1000; // 30m (free endpoint cache)
const inflight = new Map(); // debounce concurrent paid fetches per event

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[,.'‘’“”-]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function splitName(s) {
  const p = normalizeName(s).split(" ");
  return { first: p[0] || "", last: p[p.length - 1] || "" };
}
function isSamePlayer(bookName, rosterName) {
  const a = splitName(bookName), b = splitName(rosterName);
  if (!a.last || !b.last) return false;
  if (a.last !== b.last) return false;
  return (
    a.first === b.first ||
    a.first[0] === b.first[0] ||
    a.first.startsWith(b.first) ||
    b.first.startsWith(a.first)
  );
}
function median(nums) {
  const arr = nums.filter(n => typeof n === "number").sort((x, y) => x - y);
  if (!arr.length) return null;
  const m = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

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

// ---- GET /api/nfl/qb/line ----
router.get("/qb/line", async (req, res) => {
  try {
    const { playerId, refresh } = req.query;
    if (!playerId) return res.status(400).json({ error: "playerId is required" });

    // 1) Resolve player (name + team_abbr) from roster
    const season = new Date().getFullYear();
    const { players } = await roster.getQBs(season);
    const player =
      players.find(p => p.id === playerId) ||
      players.find(p => p.slug === playerId);
    if (!player) return res.status(404).json({ error: "Player not found in roster", season });

    const teamFull = TEAM_BY_ABBR[player.team_abbr];
    if (!teamFull) return res.status(400).json({ error: `Unknown team for abbr ${player.team_abbr}` });

    // 2) Free events (cached)
    const { data: events } = await getEventsCached();
    const event = findNextEventForTeam(events, teamFull);
    if (!event) {
      return res.json({
        player: { id: player.id, name: player.name, team_abbr: player.team_abbr, team_name: teamFull },
        event: null,
        no_upcoming_game: true,
      });
    }

    // 3) Paid odds (manual-first; seed once on first cache miss)
    const ODDS_CACHE_KEY = `odds:nfl:${event.id}:player_pass_yds:us`;
    const cached = cache.get(ODDS_CACHE_KEY); // no TTL → manual only
    const wantsRefresh = String(refresh).toLowerCase() === "true";

    async function fetchAndCache() {
      // de-dupe concurrent fetches per event
      if (inflight.has(ODDS_CACHE_KEY)) return await inflight.get(ODDS_CACHE_KEY);
      const p = (async () => {
        const { data, headers } = await getEventOdds(event.id, { market: "player_pass_yds", regions: "us" });
        const meta = {
          fetchedAt: new Date().toISOString(),
          headers: {
            x_last: headers["x-requests-last"],
            x_used: headers["x-requests-used"],
            x_remaining: headers["x-requests-remaining"],
          },
        };
        cache.set(ODDS_CACHE_KEY, { data, meta }); // keep until manual refresh
        return { data, meta };
      })();
      inflight.set(ODDS_CACHE_KEY, p);
      try { return await p; }
      finally { inflight.delete(ODDS_CACHE_KEY); }
    }

    let oddsBlob, oddsMeta, cacheHit = false, seeded = false;
    if (cached && !wantsRefresh) {
      oddsBlob = cached.data;
      oddsMeta = cached.meta;
      cacheHit = true;
    } else if (!cached) {
      const out = await fetchAndCache(); // seed (spends 1 credit)
      oddsBlob = out.data; oddsMeta = out.meta; seeded = true;
    } else if (wantsRefresh) {
      const out = await fetchAndCache(); // manual refresh (spends 1 credit)
      oddsBlob = out.data; oddsMeta = out.meta;
    }

    // 4) Extract this QB's pass-yds lines from the event blob
    const books = [];
    for (const b of oddsBlob.bookmakers || []) {
      const m = (b.markets || []).find(mk => mk.key === "player_pass_yds");
      if (!m) continue;
      const outs = (m.outcomes || []).filter(o => isSamePlayer(o.description || o.name || "", player.name));
      if (!outs.length) continue;

      // pair O/U by point
      const byPoint = new Map();
      for (const o of outs) {
        const k = Number.isFinite(o.point) ? String(o.point) : "nopoint";
        const prev = byPoint.get(k) || {};
        const nm = (o.name || "").toLowerCase();
        if (nm === "over") prev.over = o;
        else if (nm === "under") prev.under = o;
        prev.point = o.point;
        byPoint.set(k, prev);
      }
      const candidates = [...byPoint.values()].filter(x => typeof x.point === "number");
      const best = candidates.find(x => x.over && x.under) || candidates[0] || null;
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

    const points = books.map(b => b.point).filter(n => typeof n === "number");
    const consensus = median(points);
    const arr = points.slice().sort((a, b) => a - b);
    const points_min = arr.length ? arr[0] : null;
    const points_max = arr.length ? arr[arr.length - 1] : null;
    const q1 = quantile(arr, 0.25);
    const q3 = quantile(arr, 0.75);
    const iqr = (q1 != null && q3 != null) ? Number((q3 - q1).toFixed(1)) : null;
    const range = (points_min != null && points_max != null) ? Number((points_max - points_min).toFixed(1)) : null;


    res.json({
      player: { id: player.id, name: player.name, team_abbr: player.team_abbr, team_name: teamFull },
      event: {
        id: event.id,
        home_team: event.home_team,
        away_team: event.away_team,
        commence_time: event.commence_time,
      },
      market: "player_pass_yds",
      region: "us",
      consensus_line: consensus,
      book_count: books.length,
      books,
      points_min,
      points_max,
      points_range: range,
      points_q1: q1,
      points_q3: q3,
      points_iqr: iqr,
      as_of: oddsMeta?.fetchedAt || null,
      cache: {
        hit: cacheHit,
        seeded_on_miss: seeded,
        key: ODDS_CACHE_KEY,
        age_minutes: oddsMeta?.fetchedAt ? Math.round((Date.now() - Date.parse(oddsMeta.fetchedAt)) / 60000) : null,
        needs_refresh: false, // manual-first: never auto-refresh
      },
      credits: oddsMeta?.headers || null,
    });
  } catch (err) {
    console.error("qb/line error:", err?.response?.data || err.message);
    const status = err?.response?.status || 500;
    res.status(status).json({
      error: "Failed to fetch QB line",
      detail: err?.response?.data || err.message,
    });
  }
});


module.exports = router;
