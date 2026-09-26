// services/nflSchedule.js
// Resolves an NFL week number for an upcoming game from nflverse's published schedule —
// unlike the weekly stats CSVs (which only have rows for games already played), this
// dataset includes every game for the season up front, including future ones.
const axios = require("axios");
const { parse } = require("csv-parse");
const cache = require("../utils/cache");

const SCHEDULE_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";
const TTL_MS = 1000 * 60 * 60 * 12; // 12h, matches nflverseStats/nflverseRoster TTL convention

async function fetchSchedule() {
  const cached = cache.get(SCHEDULE_URL, TTL_MS);
  if (cached) return cached;

  const resp = await axios.get(SCHEDULE_URL, { responseType: "stream" });
  const rows = [];
  await new Promise((resolve, reject) => {
    resp.data
      .pipe(parse({ columns: true }))
      .on("data", (r) => rows.push(r))
      .on("end", resolve)
      .on("error", reject);
  });

  cache.set(SCHEDULE_URL, rows);
  return rows;
}

/**
 * Resolve the NFL week number for a matchup by (season, home team abbr, away team abbr).
 * An ordered (home, away) pair occurs at most once per regular season, even for division
 * rivals who play twice — the other meeting has the abbreviations swapped — so no date
 * matching is needed to disambiguate.
 * @returns {Promise<number|null>}
 */
async function getWeekForMatchup({ season, homeAbbr, awayAbbr }) {
  if (!season || !homeAbbr || !awayAbbr) return null;
  const rows = await fetchSchedule();
  const match = rows.find(r =>
    String(r.season) === String(season) &&
    r.game_type === "REG" &&
    r.home_team === homeAbbr &&
    r.away_team === awayAbbr
  );
  return match ? Number(match.week) : null;
}

module.exports = { getWeekForMatchup };
