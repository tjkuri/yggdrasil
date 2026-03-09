const express = require('express');
const router = express.Router();
const fs = require('fs');

const utils = require('../utils/utils');
const espnNbaApi = require('../services/espnNbaApi');
const theOddsApi = require('../services/theOddsApi');
const { mean } = require('../utils/nflMath');

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

function findOddsGameByHomeTeam(oddsGames, homeTeamName) {
  for (const g of oddsGames) {
    if (g.home_team.split(' ').pop() === homeTeamName.split(' ').pop()) return g;
  }
  return null;
}

function computeRecord(lastSix, dkLine, recommendation) {
  let wins = 0, pushes = 0, losses = 0;
  for (const total of lastSix) {
    if (total === dkLine) { pushes++; continue; }
    const wentOver = total > dkLine;
    if ((recommendation === 'O' && wentOver) || (recommendation === 'U' && !wentOver)) wins++;
    else losses++;
  }
  return { wins, pushes, losses };
}

// GET /api/nba/totals
// Returns today's NBA games with my line, DK line, recommendation, record
router.get('/totals', async (req, res) => {
  try {
    const today = utils.getToday10AMEST().slice(0, 10);

    // --- Odds (file-cached daily) ---
    const oddsFilePath = `cache/${today}-nba-total-odds.json`;
    let gamesVegasLines = await retrieveFromCache(oddsFilePath);
    if (!gamesVegasLines) {
      gamesVegasLines = await theOddsApi.fetchNbaTodayLines();
      addToCache(gamesVegasLines, oddsFilePath);
    }

    // --- Live scoreboard (5-min in-memory TTL via espnNbaApi) ---
    const scoreboard = await espnNbaApi.fetchTodayScoreboard();
    const scoreboardById = Object.fromEntries(scoreboard.map(g => [g.id, g]));

    // --- My lines (file-cached daily — only last_six, not live fields) ---
    const myLineFilePath = `cache/${today}-nba-my-lines.json`;
    let myLineData = await retrieveFromCache(myLineFilePath);
    if (!myLineData) {
      myLineData = [];
      for (const game of scoreboard) {
        const [homeGames, awayGames] = await Promise.all([
          espnNbaApi.fetchLastNTeamGames(game.home_team.id, 3),
          espnNbaApi.fetchLastNTeamGames(game.away_team.id, 3),
        ]);
        const lastSix = [...homeGames, ...awayGames].map(g => g.total).filter(t => t != null);
        myLineData.push({ id: game.id, home_team: game.home_team, away_team: game.away_team, last_six: lastSix });
      }
      addToCache(myLineData, myLineFilePath);
    }

    // --- Merge odds + pre-compute stats ---
    const result = myLineData.map(game => {
      // Always use live scoreboard for status/scores
      const live = scoreboardById[game.id] || {};
      const oddsGame = findOddsGameByHomeTeam(gamesVegasLines, game.home_team.name);
      let dkLine = null;
      if (oddsGame) {
        const dk = oddsGame.bookmakers.find(b => b.key === 'draftkings');
        if (dk) dkLine = dk.markets[0]?.outcomes[0]?.point ?? null;
      }

      const lastSix = game.last_six || [];
      const myLine = lastSix.length ? parseFloat(mean(lastSix).toFixed(2)) : null;
      const discrepancy = myLine != null && dkLine != null
        ? parseFloat((myLine - dkLine).toFixed(2))
        : null;
      const recommendation = myLine != null && dkLine != null
        ? (myLine >= dkLine ? 'O' : 'U')
        : null;
      const record = recommendation != null && dkLine != null
        ? computeRecord(lastSix, dkLine, recommendation)
        : null;

      return {
        id: game.id,
        status: live.status,
        status_detail: live.status_detail,
        period: live.period,
        home_team: game.home_team,
        away_team: game.away_team,
        home_score: live.home_score,
        away_score: live.away_score,
        my_line: myLine,
        dk_line: dkLine,
        discrepancy,
        recommendation,
        last_six: lastSix,
        record,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[nba/totals]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
