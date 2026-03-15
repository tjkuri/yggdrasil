'use strict';

const fs = require('fs');
const path = require('path');

// ─── File helpers ─────────────────────────────────────────────────────────────

async function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

// ─── isDateComplete (mirrors nbaLogger logic) ─────────────────────────────────

function isRecordLocked(record) {
  if (!record) return false;
  if (record.status === 'final') return true;
  if (record.status == null && record.home_score != null && record.away_score != null) return true;
  return false;
}

function isDateComplete(records) {
  return records.length > 0 && records.every(isRecordLocked);
}

// ─── gradeGame ────────────────────────────────────────────────────────────────

function gradeGame(pred, result, dateStr) {
  // V2 grading
  const rec = pred.opening_recommendation; // 'O', 'U', 'P', 'NO_BET'
  let v2_result = null;
  if (rec === 'O' || rec === 'U') {
    const overWon  = result.actual_total > pred.opening_dk_line;
    const underWon = result.actual_total < pred.opening_dk_line;
    const push     = result.actual_total === pred.opening_dk_line;
    if (push) v2_result = 'PUSH';
    else if (rec === 'O') v2_result = overWon  ? 'WIN' : 'LOSS';
    else                  v2_result = underWon ? 'WIN' : 'LOSS';
  }

  // V1 grading
  const v1_gap = pred.v1_line != null ? pred.v1_line - pred.opening_dk_line : null;
  let v1_direction = null;
  let v1_result    = null;
  if (v1_gap != null && v1_gap !== 0) {
    v1_direction = v1_gap > 0 ? 'O' : 'U';
    const push = result.actual_total === pred.opening_dk_line;
    if (push) v1_result = 'PUSH';
    else if (v1_direction === 'O') v1_result = result.actual_total > pred.opening_dk_line ? 'WIN' : 'LOSS';
    else                           v1_result = result.actual_total < pred.opening_dk_line ? 'WIN' : 'LOSS';
  }

  return {
    date:             dateStr,
    game_id:          pred.game_id,
    home_team:        pred.home_team,
    away_team:        pred.away_team,
    projected_total:  pred.projected_total,
    opening_dk_line:  pred.opening_dk_line,
    actual_total:     result.actual_total,
    v2_recommendation: rec,
    v2_confidence:    pred.opening_confidence,
    v2_z_score:       pred.opening_z_score,
    v2_result,
    v2_miss:          pred.projected_total != null ? result.actual_total - pred.projected_total : null,
    v1_line:          pred.v1_line,
    v1_direction,
    v1_result,
    v1_miss:          pred.v1_line != null ? result.actual_total - pred.v1_line : null,
    went_to_ot:       result.went_to_ot,
  };
}

// ─── loadGradedGames ──────────────────────────────────────────────────────────

async function loadGradedGames(cacheDir, opts = {}) {
  const files = fs.readdirSync(cacheDir)
    .filter(f => f.match(/^\d{4}-\d{2}-\d{2}-nba-predictions\.json$/))
    .sort();

  // Optionally limit to N most recent dates
  let dateFiles = files;
  if (opts.days) {
    dateFiles = files.slice(-opts.days);
  }

  const allGraded = [];

  for (const file of dateFiles) {
    const dateStr     = file.slice(0, 10);
    const predPath    = path.join(cacheDir, file);
    const resultsPath = path.join(cacheDir, `${dateStr}-nba-results.json`);

    // Skip if no paired results file
    if (!fs.existsSync(resultsPath)) continue;

    const results = await readJsonFile(resultsPath);
    if (!results || !isDateComplete(results)) continue;

    const predSnapshot = await readJsonFile(predPath);
    if (!predSnapshot || !Array.isArray(predSnapshot.games)) continue;

    const resultsByGameId = Object.fromEntries(results.map(r => [String(r.game_id), r]));

    for (const pred of predSnapshot.games) {
      const result = resultsByGameId[String(pred.game_id)];
      if (!result) continue;
      allGraded.push(gradeGame(pred, result, dateStr));
    }
  }

  return allGraded;
}

// ─── computeMetrics ───────────────────────────────────────────────────────────

function recordStats(games, getResult) {
  let wins = 0, losses = 0, pushes = 0;
  for (const g of games) {
    const r = getResult(g);
    if (r === 'WIN')  wins++;
    if (r === 'LOSS') losses++;
    if (r === 'PUSH') pushes++;
  }
  const total_bets = wins + losses;
  const win_rate = total_bets > 0 ? parseFloat((wins / total_bets).toFixed(4)) : null;
  // ROI at -110 (risk $100 to win $90.91)
  const roi = total_bets > 0
    ? parseFloat((((wins * 90.91) - (losses * 100)) / (total_bets * 100) * 100).toFixed(2))
    : null;
  return { wins, losses, pushes, total_bets, win_rate, roi };
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeMetrics(gradedGames) {
  if (!gradedGames.length) {
    return { date_range: null, total_games: 0, v2: null, v1: null };
  }

  const dates = gradedGames.map(g => g.date).sort();
  const date_range = { from: dates[0], to: dates[dates.length - 1] };

  // ── V2 ──────────────────────────────────────────────────────────────────────
  const v2Bets    = gradedGames.filter(g => g.v2_result != null);
  const v2NoBets  = gradedGames.filter(g => g.v2_result === null);
  const v2Overall = recordStats(v2Bets, g => g.v2_result);

  // By confidence
  const confidenceLevels = [...new Set(v2Bets.map(g => g.v2_confidence))].sort();
  const by_confidence = {};
  for (const lvl of confidenceLevels) {
    const group = v2Bets.filter(g => g.v2_confidence === lvl);
    by_confidence[lvl] = recordStats(group, g => g.v2_result);
  }
  // NO_BET hypothetical
  const noBetHypothetical = [];
  for (const g of v2NoBets) {
    if (g.v2_z_score == null || g.v2_z_score === 0) continue;
    const hypDir  = g.v2_z_score > 0 ? 'O' : 'U';
    const overWon  = g.actual_total > g.opening_dk_line;
    const underWon = g.actual_total < g.opening_dk_line;
    const push     = g.actual_total === g.opening_dk_line;
    let hypResult;
    if (push) hypResult = 'PUSH';
    else if (hypDir === 'O') hypResult = overWon  ? 'WIN' : 'LOSS';
    else                     hypResult = underWon ? 'WIN' : 'LOSS';
    noBetHypothetical.push(hypResult);
  }
  {
    let wins = 0, losses = 0, pushes = 0;
    for (const r of noBetHypothetical) {
      if (r === 'WIN')  wins++;
      if (r === 'LOSS') losses++;
      if (r === 'PUSH') pushes++;
    }
    const total_bets = wins + losses;
    by_confidence['NO_BET_hypothetical'] = {
      wins, losses, pushes, total_bets,
      win_rate: total_bets > 0 ? parseFloat((wins / total_bets).toFixed(4)) : null,
      roi: total_bets > 0
        ? parseFloat((((wins * 90.91) - (losses * 100)) / (total_bets * 100) * 100).toFixed(2))
        : null,
      note: 'NO BET (hypothetical)',
    };
  }

  // By direction (O / U)
  const by_direction = {};
  for (const dir of ['O', 'U']) {
    const group = v2Bets.filter(g => g.v2_recommendation === dir);
    by_direction[dir] = recordStats(group, g => g.v2_result);
  }

  // By gap size  (abs(opening_gap) buckets: 0-2, 2-5, 5+)
  const gapBuckets = [
    { label: '0-2', min: 0,  max: 2  },
    { label: '2-5', min: 2,  max: 5  },
    { label: '5+',  min: 5,  max: Infinity },
  ];
  const by_gap_size = {};
  for (const b of gapBuckets) {
    // Use opening_gap from the original prediction (stored as projected_total - dk_line)
    const group = v2Bets.filter(g => {
      const gap = Math.abs(g.opening_dk_line != null && g.projected_total != null
        ? g.projected_total - g.opening_dk_line
        : 0);
      return gap >= b.min && gap < b.max;
    });
    by_gap_size[b.label] = recordStats(group, g => g.v2_result);
  }

  // avg_miss (all graded games)
  const v2Misses = gradedGames.map(g => g.v2_miss).filter(m => m != null);
  const avg_miss = v2Misses.length > 0
    ? parseFloat((mean(v2Misses.map(Math.abs))).toFixed(2))
    : null;

  // Calibration buckets on actionable bets
  const zBuckets = [
    { label: '0.5-0.8', min: 0.5, max: 0.8  },
    { label: '0.8-1.0', min: 0.8, max: 1.0  },
    { label: '1.0-1.5', min: 1.0, max: 1.5  },
    { label: '1.5-2.0', min: 1.5, max: 2.0  },
    { label: '2.0+',    min: 2.0, max: Infinity },
  ];
  const calibration = {};
  for (const b of zBuckets) {
    const group = v2Bets.filter(g => {
      const az = Math.abs(g.v2_z_score ?? 0);
      return az >= b.min && az < b.max;
    });
    if (group.length === 0) continue;
    const stats = recordStats(group, g => g.v2_result);
    const predicted_win_prob = parseFloat((mean(group.map(g => {
      // opening_win_prob is stored in predictions; we stored it in the graded record via v2_z_score
      // Compute from z_score directly since we didn't carry opening_win_prob through
      // (The predictions file had opening_win_prob but gradeGame didn't include it)
      // Fall back: we DO have v2_z_score, use normalCDF approximation
      return normalCDFApprox(Math.abs(g.v2_z_score));
    }))).toFixed(4));
    calibration[b.label] = {
      predicted_win_prob,
      actual_win_rate: stats.win_rate,
      count: group.length,
    };
  }

  // ── V1 ──────────────────────────────────────────────────────────────────────
  const v1Bets   = gradedGames.filter(g => g.v1_result != null);
  const v1Overall = recordStats(v1Bets, g => g.v1_result);
  const v1Misses = gradedGames.map(g => g.v1_miss).filter(m => m != null);
  const avg_miss_v1 = v1Misses.length > 0
    ? parseFloat((mean(v1Misses.map(Math.abs))).toFixed(2))
    : null;

  return {
    date_range,
    total_games: gradedGames.length,
    v2: {
      ...v2Overall,
      by_confidence,
      by_direction,
      by_gap_size,
      avg_miss,
      calibration,
    },
    v1: {
      ...v1Overall,
      avg_miss: avg_miss_v1,
    },
  };
}

// ─── Minimal normalCDF approximation (Abramowitz & Stegun) ────────────────────
// Used for calibration — avoids importing nbaMath here.

function normalCDFApprox(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422820 * Math.exp(-0.5 * z * z);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z >= 0 ? 1 - p : p;
}

module.exports = { loadGradedGames, computeMetrics };
