// services/nflverseStats.js
const axios = require("axios");
const { parse } = require("csv-parse");
const cache = require("../utils/cache");
const { isSamePlayer } = require("../utils/nameMatch");
const { summarize } = require("../utils/nflMath");

const BASE = "https://github.com/nflverse/nflverse-data/releases/download/stats_player";
const TTL_MS = 1000 * 60 * 60 * 12; // 12h

const MIN_CAREER_SEASON = 2009; // oldest available nflverse dataset
const MAX_CONSECUTIVE_MISSES = 6; // stop walking back after this many empty seasons

module.exports = { fetchSeason, loadQBPassYardsBySeasons, buildScopedDistributions };


function toNumber(x) {
  if (x === null || x === undefined || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

async function fetchSeason(season) {
  const url = `${BASE}/stats_player_week_${season}.csv`;
  const cached = cache.get(url, TTL_MS);
  if (cached) return cached;

  const resp = await axios.get(url, { responseType: "stream" });
  const rows = [];
  await new Promise((resolve, reject) => {
    resp.data
      .pipe(parse({ columns: true }))
      .on("data", (r) => rows.push(r))
      .on("end", resolve)
      .on("error", reject);
  });

  cache.set(url, rows);
  return rows;
}

/**
 * Extract one week's passing record as {season, week, attempts, yards} for a given player.
 * Returns null if the row doesn't belong to this player or isn't a regular season game.
 */
function extractQBWeekRow(row, player) {
  const seasonType = (row.season_type || row.game_type || "").toUpperCase();
  if (seasonType && seasonType !== "REG" && seasonType !== "R" && seasonType !== "REGULAR") return null;

  // Match by GSIS id first, fall back to loose name match
  const gsisIds = [
    row.gsis_id, row.player_id, row.gsis, row.player_gsis_id, row.player_gsis, row.playerid_gsis,
  ].map(s => String(s || "").trim()).filter(Boolean);

  const matchesId = !!player.id && gsisIds.includes(String(player.id || "").trim());
  const rowName = String(row.player_name || row.name || `${row.first_name ?? ""} ${row.last_name ?? ""}`).trim();
  if (!matchesId && !isSamePlayer(rowName, player.name)) return null;

  const attempts =
    toNumber(row.pass_att) ?? toNumber(row.att) ??
    toNumber(row.pass_attempts) ?? toNumber(row.attempts);

  const yards =
    toNumber(row.pass_yds) ?? toNumber(row.passing_yards) ??
    toNumber(row.yards_gained_passing) ?? toNumber(row.yds);

  const season = toNumber(row.season);
  const week = toNumber(row.week);

  if (yards == null || season == null || week == null) return null;
  return { season, week, attempts: attempts ?? 0, yards };
}

/**
 * Load weekly passing yards for a player across a list of seasons.
 * Returns array of {season, week, attempts, yards}.
 */
async function loadQBPassYardsBySeasons(player, seasons) {
  const out = [];
  for (const season of seasons) {
    try {
      const rows = await fetchSeason(season);
      for (const r of rows) {
        const item = extractQBWeekRow(r, player);
        if (item) out.push(item);
      }
    } catch (_e) {
      // ignore missing seasons in older years
    }
  }
  return out;
}

/**
 * Build career/last_season/current_season passing-yards distributions for a QB.
 * Reuses pre-loaded currRows and lastRows; walks back for older career seasons.
 *
 * @param {object} player - Player object (id, name, team_abbr, etc.)
 * @param {{ currRows: object[], lastRows: object[] }} rows - Pre-loaded row data
 * @param {{ current: number, last: number, minAttempts: number, line: number|null }} opts
 * @returns {Promise<object>} Scopes object with current_season, last_season, career keys
 */
async function buildScopedDistributions(player, { currRows, lastRows }, { current, last, minAttempts, line }) {
  const filterYards = rows => rows.filter(r => (r.attempts ?? 0) >= minAttempts).map(r => r.yards);

  // Walk back through seasons to build career values
  const careerSeasons = [];
  const careerValues = [];
  let consecutiveMisses = 0;
  for (let s = current; s >= MIN_CAREER_SEASON; s--) {
    let rows;
    if (s === current) rows = currRows;
    else if (s === last) rows = lastRows;
    else rows = await loadQBPassYardsBySeasons(player, [s]);

    const vals = filterYards(rows);
    if (vals.length > 0) {
      careerSeasons.push(s);
      careerValues.push(...vals);
      consecutiveMisses = 0;
    } else {
      consecutiveMisses++;
      if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) break;
    }
  }

  const scopeCurrent = filterYards(currRows);
  const scopeLast = filterYards(lastRows);

  return {
    current_season: {
      seasons_used: scopeCurrent.length ? [current] : [],
      ...summarize(scopeCurrent, line),
    },
    last_season: {
      seasons_used: scopeLast.length ? [last] : [],
      ...summarize(scopeLast, line),
    },
    career: {
      seasons_used: careerSeasons.sort((a, b) => a - b),
      ...summarize(careerValues, line),
    },
  };
}
