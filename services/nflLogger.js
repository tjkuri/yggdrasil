// services/nflLogger.js
// Write-once prediction snapshots for the NFL QB verdict — the feedback loop Huginn's
// nfl/ engine grades against once each game is played. On-demand only (logged whenever
// /qb/analysis is actually called), keyed by (season, week, player_id) so a later re-check
// of the same QB in the same week never overwrites what was first seen.
const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "../cache/nfl-predictions");

async function writeJsonFile(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * @returns {Promise<boolean>} true if a new snapshot was written, false if one already
 *   existed for this (season, week, player) or required fields were missing.
 */
async function logPredictionIfNew({ season, week, player, opponentAbbr, line, scopeUsed, verdict, adjustedMean }) {
  if (season == null || week == null || !player?.id) return false;

  const filePath = path.join(CACHE_DIR, `${season}-wk${String(week).padStart(2, "0")}-${player.id}.json`);
  if (fs.existsSync(filePath)) return false;

  await writeJsonFile(filePath, {
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
    logged_at: new Date().toISOString(),
  });
  return true;
}

module.exports = { logPredictionIfNew };
