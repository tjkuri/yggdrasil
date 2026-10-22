// services/nflLogger.js
// Write-once prediction snapshots for the NFL QB verdict — the feedback loop Huginn's
// nfl/ engine grades against once each game is played. On-demand only (logged whenever
// /qb/analysis is actually called), keyed by (season, week, player_id) so a later re-check
// of the same QB in the same week never overwrites what was first seen.
const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "../cache/nfl-predictions");

/**
 * @returns {Promise<boolean>} true if a new snapshot was written, false if one already
 *   existed for this (season, week, player) or required fields were missing.
 */
async function logPredictionIfNew({
  season, week, player, opponentAbbr, line, scopeUsed, verdict, adjustedMean,
  marketBasis = null, bookCount = null,
}) {
  if (season == null || week == null || !player?.id || line == null) return false;

  const safeId = String(player.id).replace(/[^A-Za-z0-9._-]/g, "_");
  const filePath = path.join(CACHE_DIR, `${season}-wk${String(week).padStart(2, "0")}-${safeId}.json`);
  const data = {
    player_id: player.id,
    player_name: player.name,
    team_abbr: player.team_abbr,
    opponent_abbr: opponentAbbr,
    season,
    week,
    line,
    scope_used: scopeUsed,
    verdict,
    adjusted_mean: adjustedMean,
    // Which side of the market actually produced `line` (DraftKings vs. a consensus
    // fallback) and how many books were quoting at all — not derivable from `line` alone,
    // and needed to test whether HIGH-confidence misses cluster around thin/fallback
    // markets rather than DK's own number. Optional: older call sites that don't pass
    // these just log `null`, same as before this field existed.
    market_basis: marketBasis,
    book_count: bookCount,
    logged_at: new Date().toISOString(),
  };

  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), { flag: "wx", encoding: "utf-8" });
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
}

module.exports = { logPredictionIfNew };
