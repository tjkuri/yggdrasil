const axios = require("axios");
const { parse } = require("csv-parse");
const cache = require("../utils/cache");

const BASE = "https://github.com/nflverse/nflverse-data/releases/download/rosters";
const TTL_MS = 1000 * 60 * 60 * 12; // 12h

module.exports = {
  loadRosterForSeasonPreferCurrent,
  extractQBs,
};


// Try current season first; if missing (early offseason), fall back to prior season.
async function loadRosterForSeasonPreferCurrent(season) {
  try {
    return await fetchRosterCsv(season);
  } catch {
    if (season > 1999) {
      return await fetchRosterCsv(season - 1);
    }
    throw new Error("No roster data available.");
  }
}

async function fetchRosterCsv(season) {
  const url = `${BASE}/roster_${season}.csv`;
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

// Normalize field names that can vary slightly across seasons
function normString(x) {
  return (x ?? "").toString().trim();
}
function toBool(x) {
  if (x == null) return false;
  const s = String(x).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}


function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extract QBs with useful fields.
 * We attempt to mark starters if depth chart order is available.
 */
function extractQBs(rows) {
  return rows
    .filter((r) => String(r.position || "").toUpperCase() === "QB")
    .map((r) => {
      const first = (r.first_name || "").trim();
      const last = (r.last_name || "").trim();

      const slug = slugify(`${last}-${first}`); // e.g., mahomes-patrick

      // Prefer a canonical ID, but always include the slug
      const id =
        String(r.gsis_id || "").trim() ||
        String(r.pfr_id || "").trim() ||
        slug;

      const teamAbbr = String(r.team || r.team_abbr || "").trim();
      const name =
        (r.full_name ||
          `${first} ${last}` ||
          "").replace(/\s+/g, " ").trim();

      const status = String(r.status || "").toUpperCase();
      const isActive = status === "ACT";

      return {
        id,                // canonical where possible (GSIS/PFR)
        slug,              // friendly stable handle (matches your quick picks)
        name,
        team_abbr: teamAbbr,
        team: teamAbbr,    // no full team name in this CSV, so mirror abbr
        isActive,
        isStarter: false,  // depth not available in this CSV; leave false for now
      };
    });
}

