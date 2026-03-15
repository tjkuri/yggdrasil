const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const utils = require('../utils/utils');
const espnNbaApi = require('../services/espnNbaApi');
const theOddsApi = require('../services/theOddsApi');
const { normalCDF, computeMyLine, computeConfidenceAndEV, computeRecommendation } = require('../utils/nbaMath');
const NBA_CFG = require('../config/nba');
const nbaLogger = require('../services/nbaLogger');
const nbaBacktest = require('../services/nbaBacktest');

const CACHE_DIR = path.join(__dirname, '../cache');

// ─── File cache helpers ───────────────────────────────────────────────────────

async function addToCache(data, filePath) {
  await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8');
}

async function retrieveFromCache(filePath) {
  if (fs.existsSync(filePath)) {
    const raw = await fs.promises.readFile(filePath);
    return JSON.parse(raw);
  }
  return null;
}

// ─── Odds helpers ─────────────────────────────────────────────────────────────

function findOddsGameByHomeTeam(oddsGames, homeTeamName) {
  for (const g of oddsGames) {
    if (g.home_team.split(' ').pop() === homeTeamName.split(' ').pop()) return g;
  }
  return null;
}


// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/nba/totals
router.get('/totals', async (req, res) => {
  try {
    const today = utils.getSportsDayEST();

    // --- Live scoreboard (5-min in-memory TTL) — fetch first so we know game statuses ---
    const scoreboard = await espnNbaApi.fetchTodayScoreboard();
    const scoreboardById = Object.fromEntries(scoreboard.map(g => [g.id, g]));

    // Auto-persist results as a side effect (fire-and-forget)
    nbaLogger.writeResultsForDate(today, scoreboard)
      .catch(err => console.error('[nbaLogger results]', err));

    // Games no longer pre-game: their DK line should be frozen (live lines are meaningless to us)
    const liveHomeTeams = new Set(
      scoreboard
        .filter(g => g.status === 'STATUS_IN_PROGRESS' || g.status === 'STATUS_FINAL')
        .map(g => g.home_team.name.split(' ').pop())
    );

    // --- Odds (file-cached daily, manually refreshable) ---
    const oddsFilePath     = `cache/${today}-nba-total-odds.json`;
    const oddsOpenFilePath = `cache/${today}-nba-total-odds-open.json`;
    const refreshOdds = req.query.refreshOdds === 'true';

    let gamesVegasLines = await retrieveFromCache(oddsFilePath);
    if (!gamesVegasLines || refreshOdds) {
      const freshOdds = await theOddsApi.fetchNbaTodayLines();
      if (refreshOdds && gamesVegasLines) {
        // Only update lines for scheduled games — freeze lines for live/final games
        const freshScheduledOnly = freshOdds.filter(
          g => !liveHomeTeams.has(g.home_team.split(' ').pop())
        );
        const freshIds = new Set(freshScheduledOnly.map(g => g.id));
        gamesVegasLines = [...freshScheduledOnly, ...gamesVegasLines.filter(g => !freshIds.has(g.id))];
      } else {
        gamesVegasLines = freshOdds;
      }
      addToCache(gamesVegasLines, oddsFilePath);
      if (!fs.existsSync(oddsOpenFilePath)) {
        addToCache(gamesVegasLines, oddsOpenFilePath);
      }
    }
    const oddsOpen = await retrieveFromCache(oddsOpenFilePath);

    // --- My lines (file-cached daily — stores raw game splits, regulation-only scores) ---
    const myLineFilePath = `cache/${today}-nba-model-inputs.json`;
    let myLineData = await retrieveFromCache(myLineFilePath);
    if (!myLineData) {
      myLineData = [];
      for (const game of scoreboard) {
        const [homeGames, awayGames] = await Promise.all([
          espnNbaApi.fetchLastNTeamGames(game.home_team.id, NBA_CFG.SAMPLE_SIZE),
          espnNbaApi.fetchLastNTeamGames(game.away_team.id, NBA_CFG.SAMPLE_SIZE),
        ]);
        myLineData.push({
          id:        game.id,
          home_team: game.home_team,
          away_team: game.away_team,
          home_games: homeGames,
          away_games: awayGames,
        });
      }
      addToCache(myLineData, myLineFilePath);
    }

    // Write predictions snapshot once (when both odds-open and model-inputs are ready)
    if (oddsOpen && fs.existsSync(oddsOpenFilePath)) {
      nbaLogger.writePredictionsForDate(today, myLineData, oddsOpen)
        .catch(err => console.error('[nbaLogger predictions]', err));
    }

    // --- Merge and compute ---
    const result = myLineData.map(game => {
      const live     = scoreboardById[game.id] || {};
      const oddsGame = findOddsGameByHomeTeam(gamesVegasLines, game.home_team.name);

      let dkLine = null;
      if (oddsGame) {
        const dk = oddsGame.bookmakers.find(b => b.key === 'draftkings');
        if (dk) dkLine = dk.markets[0]?.outcomes[0]?.point ?? null;
      }

      let dkLineOpen = null;
      if (oddsOpen) {
        const openGame = findOddsGameByHomeTeam(oddsOpen, game.home_team.name);
        if (openGame) {
          const dk = openGame.bookmakers.find(b => b.key === 'draftkings');
          if (dk) dkLineOpen = dk.markets[0]?.outcomes[0]?.point ?? null;
        }
      }
      const lineMovement = dkLine != null && dkLineOpen != null && dkLine !== dkLineOpen
        ? { from: dkLineOpen, to: dkLine }
        : null;

      const { myLine, projHome, projAway, sdTotal, components } =
        computeMyLine(game.home_games, game.away_games, today, NBA_CFG);

      const discrepancy = myLine != null && dkLine != null
        ? parseFloat((myLine - dkLine).toFixed(2))
        : null;

      const { z_score, confidence, expected_value } =
        computeConfidenceAndEV(discrepancy, sdTotal, NBA_CFG);

      const recommendation = computeRecommendation(myLine, dkLine, z_score, expected_value, NBA_CFG);

      const win_probability = z_score != null
        ? parseFloat((normalCDF(Math.abs(z_score)) * 100).toFixed(1))
        : null;

      return {
        id:              game.id,
        status:          live.status,
        status_detail:   live.status_detail,
        period:          live.period,
        date:            live.date,
        home_team:       game.home_team,
        away_team:       game.away_team,
        home_score:      live.home_score,
        away_score:      live.away_score,
        my_line:         myLine  != null ? parseFloat(myLine.toFixed(2))   : null,
        proj_home:       projHome != null ? parseFloat(projHome.toFixed(2)) : null,
        proj_away:       projAway != null ? parseFloat(projAway.toFixed(2)) : null,
        dk_line:         dkLine,
        line_movement:   lineMovement,
        discrepancy,
        z_score,
        confidence,
        expected_value,
        win_probability,
        recommendation,
        sd_total:        sdTotal != null ? parseFloat(sdTotal.toFixed(4)) : null,
        components,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[nba/totals]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/nba/backtest
router.get('/backtest', async (req, res) => {
  try {
    const { days, team } = req.query;
    const opts = {};
    if (days) opts.days = parseInt(days, 10);
    let games = await nbaBacktest.loadGradedGames(CACHE_DIR, opts);
    if (team) {
      const t = team.toLowerCase();
      games = games.filter(g =>
        g.home_team.toLowerCase().includes(t) ||
        g.away_team.toLowerCase().includes(t)
      );
    }
    const metrics = nbaBacktest.computeMetrics(games);
    res.json({ games, metrics });
  } catch (err) {
    console.error('[nba/backtest]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/nba/backfill
router.get('/backfill', async (req, res) => {
  try {
    const summary = await nbaLogger.backfillLastNDays(3);
    console.log('[backfill]', JSON.stringify(summary));
    res.json(summary);
  } catch (err) {
    console.error('[nba/backfill]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
