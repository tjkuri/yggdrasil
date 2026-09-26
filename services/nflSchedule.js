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

const DATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // +/- 3 days around commence_time — comfortably covers any Thu-Mon slate + timezone slop without needing precise TZ math

/**
 * Resolve {season, week} for an upcoming game by (home/away abbr) + a date window around
 * commence_time, rather than trusting a caller-supplied season (breaks in Jan/Feb, since
 * `new Date().getFullYear()` reports next year's calendar year for Weeks 17-18, played in
 * January) or matching on team pair alone (can collide with an unrelated preseason meeting
 * between the same two teams, since preseason games aren't filtered out before this call).
 * @returns {Promise<{season: number, week: number} | null>}
 */
async function getWeekForMatchup({ homeAbbr, awayAbbr, commenceTime }) {
  if (!homeAbbr || !awayAbbr || !commenceTime) return null;
  const rows = await fetchSchedule();
  const target = new Date(commenceTime).getTime();
  if (Number.isNaN(target)) return null;

  const match = rows.find(r =>
    r.game_type === "REG" &&
    r.home_team === homeAbbr &&
    r.away_team === awayAbbr &&
    !Number.isNaN(Date.parse(r.gameday)) &&
    Math.abs(Date.parse(r.gameday) - target) <= DATE_WINDOW_MS
  );
  return match ? { season: Number(match.season), week: Number(match.week) } : null;
}

module.exports = { getWeekForMatchup };
