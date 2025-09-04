// services/nflverseStats.js
const axios = require("axios");
const { parse } = require("csv-parse");
const cache = require("../utils/cache");

const BASE = "https://github.com/nflverse/nflverse-data/releases/download/player_stats";

const TTL_MS = 1000 * 60 * 60 * 12; // 12h
module.exports = {
  fetchSeason,
  loadQBPassYardsBySeasons,
};


function n(x) {
  if (x === null || x === undefined || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function norm(s) {
  return String(s || "").trim();
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

/** Extract one week's passing record as {season, week, attempts, yards} for a given player */
function mapRowForQB(row, player) {
  // Regular season only
  const st = (row.season_type || row.game_type || "").toUpperCase();
  if (st && st !== "REG" && st !== "R" && st !== "REGULAR") return null;

  // player match: prefer GSIS id; fallback to loose name match
  const gsisCandidates = [
    row.gsis_id,
    row.player_id,          // many nflverse files use this
    row.gsis,
    row.player_gsis_id,
    row.player_gsis,
    row.playerid_gsis,
].map(norm).filter(Boolean);

const sameId = !!player.id && gsisCandidates.includes(norm(player.id));

const rowName = norm(
  row.player_name || row.name || `${row.first_name ?? ""} ${row.last_name ?? ""}`
);
const sameName = namesLooselyMatch(rowName, player.name);

if (!sameId && !sameName) return null;


  const attempts =
    n(row.pass_att) ??
    n(row.att) ??
    n(row.pass_attempts) ??
    n(row.attempts);

  const yards =
    n(row.pass_yds) ??
    n(row.passing_yards) ??
    n(row.yards_gained_passing) ??
    n(row.yds);

  const season = n(row.season);
  const week = n(row.week);

  if (yards == null || season == null || week == null) return null;

  return { season, week, attempts: attempts ?? 0, yards };
}

function namesLooselyMatch(a, b) {
  const A = splitName(a), B = splitName(b);
  if (!A.last || !B.last) return false;
  if (A.last !== B.last) return false;
  return (
    A.first === B.first ||
    (A.first && B.first && A.first[0] === B.first[0]) ||
    A.first.startsWith(B.first) || B.first.startsWith(A.first)
  );
}

function splitName(s) {
  const n = normalizeName(s).split(" ");
  return { first: n[0] || "", last: n[n.length - 1] || "" };
}

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[,.'‘’“”\-]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
        const item = mapRowForQB(r, player);
        if (item) out.push(item);
      }
    } catch (_e) {
      // ignore missing seasons in older years
    }
  }
  return out;
}

