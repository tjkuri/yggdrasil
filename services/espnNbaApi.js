const axios = require('axios');
const cache = require('../utils/cache');
const utils = require('../utils/utils');

const SCOREBOARD_TTL_MS = 5 * 60 * 1000;        // 5 min (live scores change)
const SCHEDULE_TTL_MS   = 60 * 60 * 1000;       // 1 hour (past game totals don't change)
const SUMMARY_TTL_MS    = 24 * 60 * 60 * 1000;  // 24h (completed games never change)

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const SCHEDULE_BASE  = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams';
const SUMMARY_BASE   = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary';

function scoreInt(s) {
  if (s == null) return null;
  if (typeof s === 'object') return parseInt(s.displayValue ?? s.value ?? 0);
  return parseInt(s);
}

function getNbaSeason() {
  // NBA season year = calendar year of spring finish
  // October+ → season ends next year; otherwise ends this year
  const now = new Date();
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
}

/**
 * Fetch today's NBA scoreboard from ESPN (no API key required).
 * @returns {Array<object>} Normalized array of game objects
 */
async function fetchTodayScoreboard() {
  const today = utils.getSportsDayEST().replace(/-/g, ''); // YYYYMMDD — rolls over at 4 AM ET
  const key = `espn_nba_scoreboard_${today}`;
  const cached = cache.get(key, SCOREBOARD_TTL_MS);
  if (cached) return cached;

  const res = await axios.get(`${SCOREBOARD_URL}?dates=${today}`);
  const events = res.data.events || [];

  const games = events.map(event => {
    const comp = event.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    return {
      id: event.id,
      status: event.status.type.name,          // STATUS_FINAL | STATUS_IN_PROGRESS | STATUS_SCHEDULED
      status_detail: event.status.type.shortDetail,
      period: event.status.period,
      home_team: {
        id: home.team.id,
        name: home.team.displayName,
        abbreviation: home.team.abbreviation,
      },
      away_team: {
        id: away.team.id,
        name: away.team.displayName,
        abbreviation: away.team.abbreviation,
      },
      home_score: scoreInt(home.score),
      away_score: scoreInt(away.score),
      date: event.date,  // ISO start time, used for tip-off countdown
    };
  });

  cache.set(key, games);
  return games;
}

/**
 * Fetch per-period linescores for a completed game.
 * Returns OT status and per-competitor linescores.
 * @param {string} eventId
 */
async function fetchGameSummary(eventId) {
  const key = `espn_nba_summary_${eventId}`;
  const hit = cache.get(key, SUMMARY_TTL_MS);
  if (hit) return hit;

  const res = await axios.get(`${SUMMARY_BASE}?event=${eventId}`);
  const comp = res.data.header?.competitions?.[0];
  if (!comp) return null;

  const competitors = (comp.competitors || []).map(c => ({
    teamId: String(c.team.id),
    homeAway: c.homeAway,
    linescores: (c.linescores || []).map(ls => parseInt(ls.displayValue || '0')),
  }));

  const maxPeriods = Math.max(...competitors.map(c => c.linescores.length), 0);
  const result = {
    wentToOT:    maxPeriods > 4,
    otPeriods:   Math.max(maxPeriods - 4, 0),
    competitors,
  };

  cache.set(key, result);
  return result;
}

/**
 * Fetch the last N completed regular-season games for a team by ESPN team ID.
 * @param {string} teamId - ESPN team ID
 * @param {number} n - Number of recent games to return
 * @returns {Array<{date: string, pointsScored: number, pointsAllowed: number, isHome: boolean, wentToOT: boolean}>}
 */
async function fetchLastNTeamGames(teamId, n = 3) {
  const season = getNbaSeason();
  const key = `espn_team_schedule_${teamId}_${season}`;
  const cached = cache.get(key, SCHEDULE_TTL_MS);
  if (cached) return cached.slice(0, n);

  const url = `${SCHEDULE_BASE}/${teamId}/schedule?season=${season}`;
  const res = await axios.get(url);
  const events = res.data.events || [];

  const today = utils.getSportsDayEST();

  const completed = events
    .filter(e => {
      const isRegular = e.seasonType?.type === 2;
      const comp0 = e.competitions?.[0];
      const isFinal = comp0?.status?.type?.completed === true;
      const gameDate = e.date?.slice(0, 10);
      return isRegular && isFinal && gameDate < today;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const games = (await Promise.all(completed.map(async e => {
    const comp = e.competitions[0];
    const self = comp.competitors.find(c => String(c.team.id) === String(teamId));
    const opp  = comp.competitors.find(c => String(c.team.id) !== String(teamId));
    if (!self || !opp) return null;
    const pointsScored  = scoreInt(self.score);
    const pointsAllowed = scoreInt(opp.score);
    if (pointsScored == null || pointsAllowed == null) return null;
    if (pointsScored + pointsAllowed === 0) return null;

    const isOT = comp.status?.type?.shortDetail?.includes('OT') ?? false;
    let pointsScoredRegulation  = pointsScored;
    let pointsAllowedRegulation = pointsAllowed;

    if (isOT) {
      const summary = await fetchGameSummary(e.id);
      if (summary) {
        const selfEntry = summary.competitors.find(c => c.teamId === String(teamId));
        const oppEntry  = summary.competitors.find(c => c.teamId !== String(teamId));
        if (selfEntry?.linescores.length >= 4) {
          pointsScoredRegulation  = selfEntry.linescores.slice(0, 4).reduce((a, b) => a + b, 0);
          pointsAllowedRegulation = oppEntry.linescores.slice(0, 4).reduce((a, b) => a + b, 0);
        }
      }
    }

    return {
      date:          e.date.slice(0, 10),
      pointsScored:  pointsScoredRegulation,
      pointsAllowed: pointsAllowedRegulation,
      isHome:        self.homeAway === 'home',
      wentToOT:      isOT,
    };
  }))).filter(Boolean);

  cache.set(key, games);
  return games.slice(0, n);
}

module.exports = { fetchTodayScoreboard, fetchLastNTeamGames, fetchGameSummary };
