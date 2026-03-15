const fs = require('fs');
const path = require('path');

const espnNbaApi = require('./espnNbaApi');
const { computeMyLine, computeConfidenceAndEV, computeRecommendation, normalCDF } = require('../utils/nbaMath');
const NBA_CFG = require('../config/nba');
const utils = require('../utils/utils');

const CACHE_DIR = path.join(__dirname, '../cache');

// ─── File helpers ─────────────────────────────────────────────────────────────

async function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function writeJsonFile(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Odds helpers ─────────────────────────────────────────────────────────────

function findOddsGameByHomeTeam(oddsGames, homeTeamName) {
  for (const g of oddsGames) {
    if (g.home_team.split(' ').pop() === homeTeamName.split(' ').pop()) return g;
  }
  return null;
}

function extractDkLine(oddsGame) {
  if (!oddsGame) return null;
  const dk = oddsGame.bookmakers.find(b => b.key === 'draftkings');
  return dk?.markets[0]?.outcomes[0]?.point ?? null;
}

// ─── Lock check ───────────────────────────────────────────────────────────────

// A record is locked (do not overwrite) if it's explicitly final,
// or if it has scores but no status field (legacy March 10/11 schema).
function isRecordLocked(record) {
  if (!record) return false;
  if (record.status === 'final') return true;
  if (record.status == null && record.home_score != null && record.away_score != null) return true;
  return false;
}

// A date is fully complete if all its records are locked.
function isDateComplete(records) {
  return records.length > 0 && records.every(isRecordLocked);
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

// Use game_id as primary key; fall back to home team last word for legacy records.
function recordKey(record) {
  return record.game_id || record.home_team?.split(' ').pop();
}

function scoreboardKey(game) {
  return game.id || game.home_team?.name?.split(' ').pop();
}

// ─── Date arithmetic ──────────────────────────────────────────────────────────

function offsetSportsDay(dateStr, deltaDays) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ─── Regulation score extraction ──────────────────────────────────────────────

async function getRegulationScores(game) {
  const isOT = game.status_detail?.includes('OT') ?? false;
  let homeReg = game.home_score;
  let awayReg = game.away_score;
  let otPeriods = 0;

  if (isOT) {
    const summary = await espnNbaApi.fetchGameSummary(game.id);
    if (summary) {
      otPeriods = summary.otPeriods;
      const homeEntry = summary.competitors.find(c => c.homeAway === 'home');
      const awayEntry = summary.competitors.find(c => c.homeAway === 'away');
      if (homeEntry?.linescores.length >= 4) {
        homeReg = homeEntry.linescores.slice(0, 4).reduce((a, b) => a + b, 0);
        awayReg = awayEntry.linescores.slice(0, 4).reduce((a, b) => a + b, 0);
      }
    }
  }

  return { homeReg, awayReg, isOT, otPeriods };
}

// ─── Requirement 1: Write results file ───────────────────────────────────────

/**
 * Write/update the results file for a given slate date.
 * Locks records once status is final; never overwrites locked records.
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @param {Array} scoreboardGames - from fetchScoreboardForDate / fetchTodayScoreboard
 * @returns {{ gamesWritten: number, gamesFinal: number }}
 */
async function writeResultsForDate(dateStr, scoreboardGames) {
  const filePath = path.join(CACHE_DIR, `${dateStr}-nba-results.json`);

  const existing = await readJsonFile(filePath) || [];
  const existingByKey = Object.fromEntries(existing.map(r => [recordKey(r), r]));

  let gamesWritten = 0;
  let gamesFinal = 0;

  const updated = [...existing];
  const existingKeys = new Set(existing.map(recordKey));

  for (const game of scoreboardGames) {
    const key = String(game.id);
    const homeTeamLastWord = game.home_team.name.split(' ').pop();

    // Check lock by game_id first, then by home team name (legacy fallback)
    const existingById = existingByKey[key];
    const existingByName = existingByKey[homeTeamLastWord];
    const existingRecord = existingById || existingByName;

    if (isRecordLocked(existingRecord)) {
      if (existingRecord.status === 'final') gamesFinal++;
      continue;
    }

    const isFinal = game.status === 'STATUS_FINAL';

    let record;
    if (isFinal) {
      const { homeReg, awayReg, isOT, otPeriods } = await getRegulationScores(game);
      record = {
        game_id:                  game.id,
        home_team:                game.home_team.name,
        away_team:                game.away_team.name,
        home_score:               game.home_score,
        away_score:               game.away_score,
        actual_total:             game.home_score + game.away_score,
        home_score_regulation:    homeReg,
        away_score_regulation:    awayReg,
        actual_total_regulation:  homeReg + awayReg,
        went_to_ot:               isOT,
        ot_periods:               otPeriods,
        status:                   'final',
        last_updated:             new Date().toISOString(),
      };
      gamesFinal++;
    } else {
      // In-progress or scheduled — write partial record, not locked
      record = {
        game_id:      game.id,
        home_team:    game.home_team.name,
        away_team:    game.away_team.name,
        home_score:   game.home_score,
        away_score:   game.away_score,
        status:       game.status === 'STATUS_IN_PROGRESS' ? 'in_progress' : 'scheduled',
        last_updated: new Date().toISOString(),
      };
    }

    gamesWritten++;
    if (existingKeys.has(key) || existingKeys.has(homeTeamLastWord)) {
      // Replace existing record
      const idx = updated.findIndex(r => recordKey(r) === key || recordKey(r) === homeTeamLastWord);
      if (idx !== -1) updated[idx] = record;
    } else {
      updated.push(record);
      existingKeys.add(key);
    }
  }

  if (gamesWritten > 0) {
    await writeJsonFile(filePath, updated);
  }

  return { gamesWritten, gamesFinal };
}

// ─── Requirement 2: Write predictions snapshot ───────────────────────────────

/**
 * Write prediction snapshot for a given slate date. Write-once — skips if file exists.
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @param {Array} modelInputs - from nba-model-inputs cache file
 * @param {Array} oddsOpen - from nba-total-odds-open cache file
 * @returns {boolean} true if written, false if skipped
 */
async function writePredictionsForDate(dateStr, modelInputs, oddsOpen) {
  const filePath = path.join(CACHE_DIR, `${dateStr}-nba-predictions.json`);
  if (fs.existsSync(filePath)) return false;

  const games = await Promise.all(modelInputs.map(async game => {
    const { myLine, sdTotal } = computeMyLine(game.home_games, game.away_games, dateStr, NBA_CFG);

    const oddsGame = oddsOpen ? findOddsGameByHomeTeam(oddsOpen, game.home_team.name) : null;
    const openingDkLine = extractDkLine(oddsGame);

    const discrepancy = myLine != null && openingDkLine != null
      ? parseFloat((myLine - openingDkLine).toFixed(2))
      : null;

    const { z_score, confidence, expected_value } = computeConfidenceAndEV(discrepancy, sdTotal, NBA_CFG);
    const recommendation = computeRecommendation(myLine, openingDkLine, z_score, expected_value, NBA_CFG);
    const winProb = z_score != null
      ? parseFloat((normalCDF(Math.abs(z_score)) * 100).toFixed(1))
      : null;

    // v1 baseline: mean of last 3 full game totals (including OT) before slate date
    let v1Line = null;
    try {
      const [homeRawGames, awayRawGames] = await Promise.all([
        espnNbaApi.fetchLastNTeamGamesTotal(game.home_team.id, 3, dateStr),
        espnNbaApi.fetchLastNTeamGamesTotal(game.away_team.id, 3, dateStr),
      ]);
      const allTotals = [
        ...homeRawGames.map(g => g.pointsScored + g.pointsAllowed),
        ...awayRawGames.map(g => g.pointsScored + g.pointsAllowed),
      ];
      if (allTotals.length > 0) {
        v1Line = parseFloat((allTotals.reduce((a, b) => a + b, 0) / allTotals.length).toFixed(2));
      }
    } catch (err) {
      console.error(`[nbaLogger] v1_line fetch failed for ${game.home_team.name}`, err.message);
    }

    return {
      game_id:                game.id,
      home_team:              game.home_team.name,
      away_team:              game.away_team.name,
      projected_total:        myLine != null ? parseFloat(myLine.toFixed(2)) : null,
      sd_total:               sdTotal != null ? parseFloat(sdTotal.toFixed(4)) : null,
      opening_dk_line:        openingDkLine,
      opening_gap:            discrepancy,
      opening_z_score:        z_score,
      opening_confidence:     confidence,
      opening_recommendation: recommendation,
      opening_win_prob:       winProb != null ? winProb / 100 : null,
      opening_ev:             expected_value != null ? parseFloat((expected_value * 100).toFixed(2)) : null,
      v1_line:                v1Line,
    };
  }));

  const snapshot = {
    date:          dateStr,
    model_version: 'v3',
    config: {
      sample_size:       NBA_CFG.SAMPLE_SIZE,
      decay_factor:      NBA_CFG.LAMBDA,
      min_z_threshold:   NBA_CFG.MIN_Z_THRESHOLD,
      z_medium:          NBA_CFG.Z_MEDIUM,
      z_high:            NBA_CFG.Z_HIGH,
      home_boost:        NBA_CFG.HOME_BOOST,
    },
    games,
  };

  await writeJsonFile(filePath, snapshot);
  return true;
}

// ─── Requirement 3: Backfill ──────────────────────────────────────────────────

/**
 * Backfill results (and predictions if inputs exist) for the last n sports days.
 * Idempotent — skips fully complete dates.
 * @param {number} n
 * @returns {Array<{date, status, gamesUpdated, predictionsWritten}>}
 */
async function backfillLastNDays(n = 3) {
  const today = utils.getSportsDayEST();
  const dates = Array.from({ length: n }, (_, i) => offsetSportsDay(today, -i));

  const report = [];

  for (const dateStr of dates) {
    const resultsPath = path.join(CACHE_DIR, `${dateStr}-nba-results.json`);
    const modelInputsPath = path.join(CACHE_DIR, `${dateStr}-nba-model-inputs.json`);
    const oddsOpenPath = path.join(CACHE_DIR, `${dateStr}-nba-total-odds-open.json`);

    const existing = await readJsonFile(resultsPath);
    const allFinal = existing && isDateComplete(existing);

    let gamesUpdated = 0;
    let status;

    if (allFinal) {
      status = 'complete';
      console.log(`[backfill] ${dateStr}: all games final, skipping results`);
    } else {
      let scoreboard;
      try {
        scoreboard = await espnNbaApi.fetchScoreboardForDate(dateStr);
      } catch (err) {
        console.error(`[backfill] ${dateStr}: ESPN fetch failed —`, err.message);
        report.push({ date: dateStr, status: 'error', gamesUpdated: 0, predictionsWritten: false });
        continue;
      }

      if (!scoreboard || scoreboard.length === 0) {
        status = 'no_data';
        console.log(`[backfill] ${dateStr}: no games found`);
      } else {
        const { gamesWritten, gamesFinal } = await writeResultsForDate(dateStr, scoreboard);
        gamesUpdated = gamesWritten;
        status = gamesWritten > 0 ? 'updated' : 'complete';
        console.log(`[backfill] ${dateStr}: wrote ${gamesWritten} records (${gamesFinal} final)`);
      }
    }

    // Generate predictions if inputs exist and predictions file doesn't
    let predictionsWritten = false;
    const modelInputs = await readJsonFile(modelInputsPath);
    const oddsOpen = await readJsonFile(oddsOpenPath);
    if (modelInputs && oddsOpen) {
      try {
        predictionsWritten = await writePredictionsForDate(dateStr, modelInputs, oddsOpen);
        if (predictionsWritten) {
          console.log(`[backfill] ${dateStr}: predictions snapshot written`);
        }
      } catch (err) {
        console.error(`[backfill] ${dateStr}: predictions write failed —`, err.message);
      }
    }

    report.push({ date: dateStr, status, gamesUpdated, predictionsWritten });
  }

  return report;
}

module.exports = { writeResultsForDate, writePredictionsForDate, backfillLastNDays };
