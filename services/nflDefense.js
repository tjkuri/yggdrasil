// services/nflDefense.js
// Opponent-adjustment factors for NFL pass defenses.
//
// Two signals, both derived from nflverse weekly stats (reuses nflverseStats' own cache):
//   1. pass_ypa_factor  — (pass yds allowed / att faced) vs league avg. The standard
//      opponent-adjustment unit (DVOA-style): efficiency, not raw yards allowed, so a
//      defense that faces heavy volume isn't mistaken for a bad pass defense.
//   2. rush_stop_factor — league ypc / team ypc allowed. A stout run defense pushes
//      opponents to throw more ("pass funnel"); verified corr ~0.30 with QB attempts
//      faced in 2025 data — real, but weaker than the efficiency signal, so it's
//      dampened (VOLUME_DAMPEN_EXP) before being folded in as attempts_factor.
//
// Current + prior season are blended with recency weighting, then each team's factor
// is shrunk toward 1.0 (league average) by its weighted sample size — thin/early-season
// data pulls toward neutral instead of overreacting.

const { fetchSeason } = require("./nflverseStats");
const NFL = require("../config/nfl");

function toNumber(x) {
  if (x === null || x === undefined || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function isRegSeason(row) {
  const t = (row.season_type || row.game_type || "").toUpperCase();
  return !t || t === "REG" || t === "R" || t === "REGULAR";
}

/**
 * Fold one season's weekly rows into per-team pass/rush "allowed" aggregates, recency-weighted.
 * `weight` (used for shrinkage) is accumulated once per distinct game_id, not once per row —
 * a single game has one qualifying passer row but several rushers (RB/WR/QB scrambles), so
 * counting rows would inflate the rush sample size far past the actual number of games played
 * and under-shrink a signal that's supposed to be shrunk harder than the pass factor.
 */
function accumulate(rows, weight, passAgg, rushAgg) {
  for (const row of rows) {
    if (!isRegSeason(row)) continue;
    const opp = String(row.opponent_team || "").trim();
    const gameId = row.game_id;
    if (!opp || !gameId) continue;

    const attempts = toNumber(row.attempts);
    const passYards = toNumber(row.passing_yards);
    if (attempts != null && attempts >= NFL.MIN_ATTEMPTS_DEF_ROW && passYards != null) {
      const b = passAgg.get(opp) || { yards: 0, attempts: 0, weight: 0, games: new Set() };
      b.yards += passYards * weight;
      b.attempts += attempts * weight;
      if (!b.games.has(gameId)) { b.games.add(gameId); b.weight += weight; }
      passAgg.set(opp, b);
    }

    const carries = toNumber(row.carries);
    const rushYards = toNumber(row.rushing_yards);
    if (carries != null && carries > 0 && rushYards != null) {
      const b = rushAgg.get(opp) || { yards: 0, carries: 0, weight: 0, games: new Set() };
      b.yards += rushYards * weight;
      b.carries += carries * weight;
      if (!b.games.has(gameId)) { b.games.add(gameId); b.weight += weight; }
      rushAgg.set(opp, b);
    }
  }
}

/** factor = (n*raw + k*1.0) / (n + k) — pulls toward league-average (1.0) when n is thin. */
function shrinkToLeagueAvg(rawFactor, weightedN, k) {
  if (rawFactor == null || !weightedN) return 1.0;
  return (weightedN * rawFactor + k) / (weightedN + k);
}

/**
 * Build per-team defensive matchup factors, blending current + prior season.
 * @param {{ current: number, prior: number }} seasons
 * @returns {Promise<Record<string, { pass_ypa_factor:number, rush_stop_factor:number, attempts_factor:number, matchup_factor:number, sample:object }>>}
 */
async function getDefenseProfiles({ current, prior }) {
  const passAgg = new Map();
  const rushAgg = new Map();

  const [currRows, priorRows] = await Promise.all([
    fetchSeason(current).catch(() => []),
    fetchSeason(prior).catch(() => []),
  ]);
  accumulate(currRows, NFL.RECENCY_WEIGHT_CURRENT, passAgg, rushAgg);
  accumulate(priorRows, NFL.RECENCY_WEIGHT_PRIOR, passAgg, rushAgg);

  let lgPassYds = 0, lgPassAtt = 0, lgRushYds = 0, lgRushCarries = 0;
  for (const b of passAgg.values()) { lgPassYds += b.yards; lgPassAtt += b.attempts; }
  for (const b of rushAgg.values()) { lgRushYds += b.yards; lgRushCarries += b.carries; }
  const leagueYpa = lgPassAtt > 0 ? lgPassYds / lgPassAtt : null;
  const leagueYpc = lgRushCarries > 0 ? lgRushYds / lgRushCarries : null;

  const teams = new Set([...passAgg.keys(), ...rushAgg.keys()]);
  const profiles = {};

  for (const team of teams) {
    const p = passAgg.get(team);
    const r = rushAgg.get(team);

    let passYpaFactor = 1.0;
    if (p && leagueYpa) {
      const teamYpa = p.yards / p.attempts;
      passYpaFactor = shrinkToLeagueAvg(teamYpa / leagueYpa, p.weight, NFL.SHRINK_K_PASS);
    }

    let rushStopFactor = 1.0;
    if (r && leagueYpc) {
      const teamYpc = r.yards / r.carries;
      rushStopFactor = shrinkToLeagueAvg(leagueYpc / teamYpc, r.weight, NFL.SHRINK_K_RUSH);
    }
    const attemptsFactor = Math.pow(rushStopFactor, NFL.VOLUME_DAMPEN_EXP);

    profiles[team] = {
      pass_ypa_factor: Number(passYpaFactor.toFixed(3)),
      rush_stop_factor: Number(rushStopFactor.toFixed(3)),
      attempts_factor: Number(attemptsFactor.toFixed(3)),
      matchup_factor: Number((passYpaFactor * attemptsFactor).toFixed(3)),
      sample: {
        pass_games_weighted: p ? Number(p.weight.toFixed(1)) : 0,
        rush_games_weighted: r ? Number(r.weight.toFixed(1)) : 0,
        pass_games: p ? p.games.size : 0,
        rush_games: r ? r.games.size : 0,
      },
    };
  }

  return profiles;
}

module.exports = { getDefenseProfiles };
