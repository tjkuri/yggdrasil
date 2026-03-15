#!/usr/bin/env node
'use strict';

const path  = require('path');
const chalk = require('chalk');
const Table = require('cli-table3');
const { loadGradedGames, computeMetrics } = require('../services/nbaBacktest');

const CACHE_DIR = path.join(__dirname, '../cache');

// ─── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let days     = null;
let team     = null;
let jsonMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[++i], 10); }
  if (args[i] === '--team' && args[i + 1]) { team = args[++i]; }
  if (args[i] === '--json') { jsonMode = true; }
}

// ─── Color helpers ────────────────────────────────────────────────────────────

const WIN_THRESHOLD = 0.524; // break-even at -110

function colorRoi(roi) {
  if (roi == null) return chalk.dim('N/A');
  const s = (roi >= 0 ? '+' : '') + roi.toFixed(2) + '%';
  return roi > 0 ? chalk.green(s) : chalk.red(s);
}

function colorWinRate(rate) {
  if (rate == null) return chalk.dim('N/A');
  const s = (rate * 100).toFixed(1) + '%';
  return rate >= WIN_THRESHOLD ? chalk.green(s) : chalk.red(s);
}

function colorRecord(wins, losses, pushes) {
  const w = chalk.green(wins + 'W');
  const l = chalk.red(losses + 'L');
  const p = chalk.dim(pushes + 'P');
  return `${w}-${l}-${p}`;
}

function colorResult(result) {
  if (result === 'WIN')  return chalk.green('WIN');
  if (result === 'LOSS') return chalk.red('LOSS');
  if (result === 'PUSH') return chalk.yellow('PUSH');
  return chalk.dim('-');
}

function v2Icon(result) {
  if (result === 'WIN')  return chalk.green('✓');
  if (result === 'LOSS') return chalk.red('✗');
  return chalk.dim('–');
}

function warnIfSmall(n, threshold = 10) {
  if (n < threshold) return chalk.yellow(` ⚠ n=${n}`);
  return chalk.dim(` n=${n}`);
}

function sectionHeader(title) {
  return chalk.bold.white(`\n ${'─'.repeat(3)} ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

function statsRow(s) {
  if (s.total_bets === 0) return chalk.dim('0W-0L-0P  (0 bets)  N/A  N/A');
  return `${colorRecord(s.wins, s.losses, s.pushes)}  (${s.total_bets} bets)  ${colorWinRate(s.win_rate)}  ${colorRoi(s.roi)}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = {};
  if (days) opts.days = days;

  let games = await loadGradedGames(CACHE_DIR, opts);

  if (team) {
    const t = team.toLowerCase();
    games = games.filter(g =>
      g.home_team.toLowerCase().includes(t) ||
      g.away_team.toLowerCase().includes(t)
    );
  }

  const metrics = computeMetrics(games);

  if (jsonMode) {
    console.log(JSON.stringify({ games, metrics }, null, 2));
    return;
  }

  const { date_range, total_games, v2, v1 } = metrics;

  // ── Banner ───────────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold.white(' NBA BACKTEST REPORT'));
  console.log(chalk.dim(' ' + '─'.repeat(60)));
  if (date_range) {
    console.log(chalk.dim(` Date range : ${date_range.from} → ${date_range.to}`));
  }
  console.log(chalk.dim(` Total games: ${total_games}${team ? `  (filter: ${team})` : ''}`));

  // ── V2 model ─────────────────────────────────────────────────────────────────
  console.log(sectionHeader('V2 MODEL'));
  if (!v2) {
    console.log(chalk.dim('  No V2 data.'));
  } else {
    console.log(`  Overall    ${statsRow(v2)}`);
    console.log(`  Avg miss   ${v2.avg_miss != null ? v2.avg_miss.toFixed(2) + ' pts' : chalk.dim('N/A')}`);

    // By confidence
    console.log('');
    const confTable = new Table({
      head: [chalk.dim('Confidence'), chalk.dim('Record'), chalk.dim('Bets'), chalk.dim('Win%'), chalk.dim('ROI')],
      style: { head: [], border: ['dim'] },
      chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
    });
    for (const [lvl, s] of Object.entries(v2.by_confidence)) {
      const label = s.note
        ? chalk.dim(lvl)
        : lvl === 'HIGH' ? chalk.green(lvl) : lvl === 'MEDIUM' ? chalk.yellow(lvl) : chalk.dim(lvl);
      confTable.push([
        label + (s.note ? chalk.dim('  ← hypothetical') : ''),
        s.total_bets === 0 ? chalk.dim('0W-0L-0P') : colorRecord(s.wins, s.losses, s.pushes),
        s.total_bets === 0 ? chalk.dim('0') : String(s.total_bets),
        colorWinRate(s.win_rate),
        colorRoi(s.roi),
      ]);
    }
    console.log(confTable.toString());

    // By direction + gap size side by side via two tables
    console.log('');
    const dirTable = new Table({
      head: [chalk.dim('Direction'), chalk.dim('Record'), chalk.dim('Bets'), chalk.dim('Win%'), chalk.dim('ROI')],
      style: { head: [], border: ['dim'] },
      chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
    });
    for (const [dir, s] of Object.entries(v2.by_direction)) {
      dirTable.push([
        chalk.white(dir),
        s.total_bets === 0 ? chalk.dim('0W-0L-0P') : colorRecord(s.wins, s.losses, s.pushes),
        s.total_bets === 0 ? chalk.dim('0') : String(s.total_bets),
        colorWinRate(s.win_rate),
        colorRoi(s.roi),
      ]);
    }
    const gapTable = new Table({
      head: [chalk.dim('Gap |pts|'), chalk.dim('Record'), chalk.dim('Bets'), chalk.dim('Win%'), chalk.dim('ROI')],
      style: { head: [], border: ['dim'] },
      chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
    });
    for (const [bucket, s] of Object.entries(v2.by_gap_size)) {
      gapTable.push([
        chalk.white(bucket),
        s.total_bets === 0 ? chalk.dim('0W-0L-0P') : colorRecord(s.wins, s.losses, s.pushes),
        s.total_bets === 0 ? chalk.dim('0') : String(s.total_bets),
        colorWinRate(s.win_rate),
        colorRoi(s.roi),
      ]);
    }
    // Print direction and gap tables labeled
    console.log(chalk.dim('  By direction:'));
    console.log(dirTable.toString());
    console.log(chalk.dim('  By gap size (|proj − DK|):'));
    console.log(gapTable.toString());

    // Calibration
    if (Object.keys(v2.calibration).length > 0) {
      console.log('');
      console.log(chalk.dim('  Calibration  (|z| bucket → predicted vs actual win%):'));
      const calTable = new Table({
        head: [chalk.dim('|z| bucket'), chalk.dim('Predicted'), chalk.dim('Actual'), chalk.dim('n')],
        style: { head: [], border: ['dim'] },
        chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
      });
      for (const [bucket, c] of Object.entries(v2.calibration)) {
        const pred = c.predicted_win_prob != null ? (c.predicted_win_prob * 100).toFixed(1) + '%' : chalk.dim('N/A');
        calTable.push([
          chalk.white(bucket),
          chalk.dim(pred),
          colorWinRate(c.actual_win_rate) + warnIfSmall(c.count),
          String(c.count),
        ]);
      }
      console.log(calTable.toString());
    }
  }

  // ── V1 baseline ───────────────────────────────────────────────────────────────
  console.log(sectionHeader('V1 BASELINE'));
  if (!v1) {
    console.log(chalk.dim('  No V1 data.'));
  } else {
    console.log(`  Overall    ${statsRow(v1)}`);
    console.log(`  Avg miss   ${v1.avg_miss != null ? v1.avg_miss.toFixed(2) + ' pts' : chalk.dim('N/A')}`);
  }

  // ── Game log ──────────────────────────────────────────────────────────────────
  console.log(sectionHeader('GAME LOG'));
  const logTable = new Table({
    head: [
      chalk.dim('Date'),
      chalk.dim('Matchup'),
      chalk.dim('DK'),
      chalk.dim('Proj'),
      chalk.dim('Actual'),
      chalk.dim('Rec'),
      chalk.dim('V2'),
      chalk.dim('V1 line'),
      chalk.dim('V1'),
      chalk.dim('OT'),
    ],
    style: { head: [], border: ['dim'] },
    chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
    colWidths: [12, 38, 7, 7, 8, 10, 7, 8, 7, 4],
  });

  for (const g of games) {
    const matchup = `${g.away_team} @ ${g.home_team}`;
    const rec     = g.v2_recommendation ?? '-';
    const recStr  = rec === 'O' ? chalk.cyan('O')
      : rec === 'U' ? chalk.magenta('U')
      : chalk.dim(rec);
    const otStr   = g.went_to_ot ? chalk.yellow('OT') : '';

    logTable.push([
      chalk.dim(g.date),
      matchup.length > 36 ? matchup.slice(0, 35) + '…' : matchup,
      g.opening_dk_line ?? '-',
      g.projected_total != null ? g.projected_total.toFixed(1) : chalk.dim('-'),
      g.actual_total ?? '-',
      recStr + ' ' + v2Icon(g.v2_result),
      colorResult(g.v2_result),
      g.v1_line != null ? g.v1_line.toFixed(1) : chalk.dim('-'),
      colorResult(g.v1_result),
      otStr,
    ]);
  }

  console.log(logTable.toString());
  console.log('');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
