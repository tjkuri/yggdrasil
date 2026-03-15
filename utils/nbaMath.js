/**
 * Exponential recency-weighted mean.
 * @param {Array<{date: string, value: number}>} items - sorted newest-first
 * @param {string} today   - 'YYYY-MM-DD' reference date
 * @param {number} lambda  - decay base per day (e.g. 0.96)
 * @returns {number|null}
 */
function weightedMean(items, today, lambda) {
  if (!items || items.length === 0) return null;
  const todayMs = new Date(today).getTime();
  let weightedSum = 0, weightSum = 0;
  for (const item of items) {
    const daysSince = (todayMs - new Date(item.date).getTime()) / 86400000;
    const w = Math.pow(lambda, daysSince);
    weightedSum += item.value * w;
    weightSum += w;
  }
  return weightSum > 0 ? weightedSum / weightSum : null;
}

/**
 * Exponential recency-weighted population variance.
 * @param {Array<{date: string, value: number}>} items
 * @param {string} today
 * @param {number} lambda
 * @param {number} wMean  - pre-computed weightedMean (avoids double work)
 * @returns {number|null}
 */
function weightedVariance(items, today, lambda, wMean) {
  if (!items || items.length < 2 || wMean == null) return null;
  const todayMs = new Date(today).getTime();
  let weightedSumSq = 0, weightSum = 0;
  for (const item of items) {
    const daysSince = (todayMs - new Date(item.date).getTime()) / 86400000;
    const w = Math.pow(lambda, daysSince);
    weightedSumSq += w * Math.pow(item.value - wMean, 2);
    weightSum += w;
  }
  return weightSum > 0 ? weightedSumSq / weightSum : null;
}

/**
 * Normal CDF via Abramowitz & Stegun rational approximation.
 * Accurate to ~1.5e-7 for all z.
 * normalCDF(0) → 0.5, normalCDF(1.96) → ~0.975
 * @param {number} z
 * @returns {number} probability in [0, 1]
 */
function normalCDF(z) {
  const sign = z < 0 ? -1 : 1;
  const absZ = Math.abs(z);
  const t = 1.0 / (1.0 + 0.2316419 * absZ);
  const poly = t * (0.319381530
    + t * (-0.356563782
    + t * (1.781477937
    + t * (-1.821255978
    + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * absZ * absZ) / Math.sqrt(2 * Math.PI);
  const cdf = 1.0 - pdf * poly;
  return 0.5 * (1.0 + sign * (2 * cdf - 1));
}

// ─── Model math (shared between routes/nba.js and services/nbaLogger.js) ─────

function toItems(games, field) {
  return games.map(g => ({ date: g.date, value: g[field] }));
}

/**
 * Compute projected total using O/D splits, recency weighting, and home court.
 */
function computeMyLine(homeGames, awayGames, today, cfg) {
  const { LAMBDA, HOME_BOOST, MIN_HOME_AWAY_GAMES } = cfg;

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

  const projHome = (homeOff + awayDef) / 2 + homeBoost / 2;
  const projAway = (awayOff + homeDef) / 2 - homeBoost / 2;
  const myLine   = projHome + projAway;

  const varHomeOff = weightedVariance(homeOffItems, today, LAMBDA, homeOff);
  const varHomeDef = weightedVariance(homeDefItems, today, LAMBDA, homeDef);
  const varAwayOff = weightedVariance(awayOffItems, today, LAMBDA, awayOff);
  const varAwayDef = weightedVariance(awayDefItems, today, LAMBDA, awayDef);

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
 */
function computeConfidenceAndEV(discrepancy, sdTotal, cfg) {
  const { Z_HIGH, Z_MEDIUM, VIG_WIN, VIG_RISK } = cfg;
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
 * Determine recommendation based on edge thresholds.
 */
function computeRecommendation(myLine, dkLine, z_score, expected_value, cfg) {
  const { MIN_Z_THRESHOLD } = cfg;
  if (myLine == null || dkLine == null) return null;
  if (z_score == null || Math.abs(z_score) < MIN_Z_THRESHOLD || expected_value <= 0) return 'NO_BET';
  if (myLine > dkLine) return 'O';
  if (myLine < dkLine) return 'U';
  return 'P';
}

module.exports = { weightedMean, weightedVariance, normalCDF, computeMyLine, computeConfidenceAndEV, computeRecommendation };
