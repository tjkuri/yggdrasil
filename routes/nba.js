const express = require('express');
const router = express.Router();
const fs = require('fs');

const utils = require('../utils/utils');
const espnNbaApi = require('../services/espnNbaApi');
const theOddsApi = require('../services/theOddsApi');
const { weightedMean, weightedVariance, normalCDF } = require('../utils/nbaMath');
const NBA_CFG = require('../config/nba');

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

// ─── Math helpers ─────────────────────────────────────────────────────────────

function toItems(games, field) {
  return games.map(g => ({ date: g.date, value: g[field] }));
}

/**
 * Compute my_line and variance using O/D splits, recency weighting, and home court.
 * Implements Upgrades 1, 2, 3, 4, 5.
 */
function computeMyLine(homeGames, awayGames, today) {
  const { LAMBDA, HOME_BOOST, MIN_HOME_AWAY_GAMES } = NBA_CFG;

  const homeOffItems = toItems(homeGames, 'pointsScored');
  const homeDefItems = toItems(homeGames, 'pointsAllowed');
  const awayOffItems = toItems(awayGames, 'pointsScored');
  const awayDefItems = toItems(awayGames, 'pointsAllowed');

  const homeOff = weightedMean(homeOffItems, today, LAMBDA);
  const homeDef = weightedMean(homeDefItems, today, LAMBDA);
  const awayOff = weightedMean(awayOffItems, today, LAMBDA);
  const awayDef = weightedMean(awayDefItems, today, LAMBDA);

  if (homeOff == null || homeDef == null || awayOff == null || awayDef == null) {
    return { myLine: null, projHome: null, projAway: null, sdTotal: null, components: null };
  }

  // Upgrade 5: home court — use venue split if sufficient games, else flat boost
  let homeBoost = HOME_BOOST;
  const homeAtHome = homeGames.filter(g => g.isHome);
  const homeAway   = homeGames.filter(g => !g.isHome);
  if (homeAtHome.length >= MIN_HOME_AWAY_GAMES && homeAway.length >= MIN_HOME_AWAY_GAMES) {
    const atHomeMean = weightedMean(toItems(homeAtHome, 'pointsScored'), today, LAMBDA);
    const awayMean   = weightedMean(toItems(homeAway,   'pointsScored'), today, LAMBDA);
    if (atHomeMean != null && awayMean != null) {
      homeBoost = atHomeMean - awayMean;
    }
  }

  // Upgrade 1: O/D split projection
  const projHome = (homeOff + awayDef) / 2 + homeBoost / 2;
  const projAway = (awayOff + homeDef) / 2 - homeBoost / 2;
  const myLine   = projHome + projAway;

  // Upgrade 4: weighted variance per component
  const varHomeOff = weightedVariance(homeOffItems, today, LAMBDA, homeOff);
  const varHomeDef = weightedVariance(homeDefItems, today, LAMBDA, homeDef);
  const varAwayOff = weightedVariance(awayOffItems, today, LAMBDA, awayOff);
  const varAwayDef = weightedVariance(awayDefItems, today, LAMBDA, awayDef);

  // Propagate: Var((X+Y)/2) = (Var(X)+Var(Y))/4
  const varTotal = ((varHomeOff ?? 0) + (varAwayDef ?? 0)) / 4
                 + ((varAwayOff ?? 0) + (varHomeDef ?? 0)) / 4;
  const sdTotal = varTotal > 0 ? Math.sqrt(varTotal) : null;

  return {
    myLine,
    projHome,
    projAway,
    sdTotal,
    components: { homeOff, homeDef, awayOff, awayDef, homeBoost },
  };
}

/**
 * Compute z-score, confidence tier, and vig-adjusted EV.
 * Implements Upgrades 4, 6.
 */
function computeConfidenceAndEV(discrepancy, sdTotal) {
  const { Z_HIGH, Z_MEDIUM, VIG_WIN, VIG_RISK } = NBA_CFG;
  if (sdTotal == null || sdTotal === 0 || discrepancy == null) {
    return { z_score: null, confidence: null, expected_value: null };
  }
  const z    = discrepancy / sdTotal;
  const absZ = Math.abs(z);
  const confidence = absZ >= Z_HIGH ? 'HIGH' : absZ >= Z_MEDIUM ? 'MEDIUM' : 'LOW';
  const impliedWinProb = normalCDF(absZ);
  const ev = impliedWinProb * VIG_WIN - (1 - impliedWinProb) * VIG_RISK;
  return {
    z_score:        parseFloat(z.toFixed(3)),
    confidence,
    expected_value: parseFloat(ev.toFixed(4)),
  };
}

/**
 * Determine recommendation. Implements Upgrade 6 (minimum edge threshold).
 */
function computeRecommendation(myLine, dkLine, z_score, expected_value) {
  const { MIN_Z_THRESHOLD } = NBA_CFG;
  if (myLine == null || dkLine == null) return null;
  if (z_score == null || Math.abs(z_score) < MIN_Z_THRESHOLD || expected_value <= 0) return 'NO_BET';
  if (myLine > dkLine) return 'O';
  if (myLine < dkLine) return 'U';
  return 'P';
}


// ─── Route ────────────────────────────────────────────────────────────────────

// GET /api/nba/totals
router.get('/totals', async (req, res) => {
  try {
    const today = utils.getToday10AMEST().slice(0, 10);

    // --- Odds (file-cached daily, manually refreshable) ---
    const oddsFilePath     = `cache/${today}-nba-total-odds.json`;
    const oddsOpenFilePath = `cache/${today}-nba-total-odds-open.json`;
    const refreshOdds = req.query.refreshOdds === 'true';

    let gamesVegasLines = await retrieveFromCache(oddsFilePath);
    if (!gamesVegasLines || refreshOdds) {
      const freshOdds = await theOddsApi.fetchNbaTodayLines();
      if (refreshOdds && gamesVegasLines) {
        const freshIds = new Set(freshOdds.map(g => g.id));
        gamesVegasLines = [...freshOdds, ...gamesVegasLines.filter(g => !freshIds.has(g.id))];
      } else {
        gamesVegasLines = freshOdds;
      }
      addToCache(gamesVegasLines, oddsFilePath);
      if (!fs.existsSync(oddsOpenFilePath)) {
        addToCache(gamesVegasLines, oddsOpenFilePath);
      }
    }
    const oddsOpen = await retrieveFromCache(oddsOpenFilePath);

    // --- Live scoreboard (5-min in-memory TTL) ---
    const scoreboard = await espnNbaApi.fetchTodayScoreboard();
    const scoreboardById = Object.fromEntries(scoreboard.map(g => [g.id, g]));

    // --- My lines (file-cached daily v2 — stores raw game splits, not totals) ---
    const myLineFilePath = `cache/${today}-nba-my-lines-v2.json`;
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
        computeMyLine(game.home_games, game.away_games, today);

      const discrepancy = myLine != null && dkLine != null
        ? parseFloat((myLine - dkLine).toFixed(2))
        : null;

      const { z_score, confidence, expected_value } =
        computeConfidenceAndEV(discrepancy, sdTotal);

      const recommendation = computeRecommendation(myLine, dkLine, z_score, expected_value);

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
        components,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[nba/totals]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
