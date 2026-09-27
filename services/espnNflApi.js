const axios = require("axios");
const cache = require("../utils/cache");

const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const TEAMS_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams";
const SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary";

const SCOREBOARD_TTL_MS = 1000 * 60 * 5;       // 5 min — status/score change during game days
const DEPTHCHART_TTL_MS = 1000 * 60 * 60 * 12; // 12h — matches nflverseRoster.js's TTL convention
const SUMMARY_TTL_MS = 1000 * 60 * 60 * 12;    // 12h — a finished game's boxscore never changes

// Confirmed via a live cross-check of all 32 teams during planning (2026-09-27): every
// abbreviation matches between ESPN and this codebase's nflTeamNames.js EXCEPT these two.
const ESPN_ABBR_TO_OURS = { LAR: "LA", WSH: "WAS" };

module.exports = { fetchWeekScoreboard, fetchDepthChart, fetchGameSummary, normalizeEspnAbbr };

function normalizeEspnAbbr(espnAbbr) {
  return ESPN_ABBR_TO_OURS[espnAbbr] || espnAbbr;
}

async function fetchWeekScoreboard() {
  const cached = cache.get(SCOREBOARD_URL, SCOREBOARD_TTL_MS);
  if (cached) return cached;

  const res = await axios.get(SCOREBOARD_URL);
  const games = (res.data.events || []).map(ev => {
    const comp = ev.competitions?.[0];
    const status = comp?.status?.type || {};
    const home = comp?.competitors?.find(c => c.homeAway === "home");
    const away = comp?.competitors?.find(c => c.homeAway === "away");
    const side = c => c ? {
      abbr: normalizeEspnAbbr(c.team.abbreviation),
      name: c.team.displayName,
      espn_team_id: c.team.id,
      score: c.score != null ? Number(c.score) : null,
    } : null;
    return {
      id: ev.id,
      commence_time: ev.date,
      state: status.state || "pre",
      short_detail: status.shortDetail || "",
      home: side(home),
      away: side(away),
    };
  });

  cache.set(SCOREBOARD_URL, games);
  return games;
}

async function fetchDepthChart(espnTeamId) {
  const key = `espn_nfl_depthchart_${espnTeamId}`;
  const cached = cache.get(key, DEPTHCHART_TTL_MS);
  if (cached) return cached;

  const res = await axios.get(`${TEAMS_BASE}/${espnTeamId}/depthcharts`);
  let qbs = [];
  for (const chart of res.data.depthchart || []) {
    const qbPosition = chart.positions?.qb;
    if (qbPosition?.athletes?.length) {
      qbs = qbPosition.athletes.map(a => ({ id: a.id, displayName: a.displayName }));
      break;
    }
  }

  cache.set(key, qbs);
  return qbs;
}

async function fetchGameSummary(espnEventId) {
  const key = `espn_nfl_summary_${espnEventId}`;
  const cached = cache.get(key, SUMMARY_TTL_MS);
  if (cached) return cached;

  const res = await axios.get(`${SUMMARY_URL}?event=${espnEventId}`);
  const passing = [];
  for (const team of res.data.boxscore?.players || []) {
    const passingCat = team.statistics?.find(s => s.name === "passing");
    if (!passingCat) continue;
    const ydsIdx = passingCat.labels.indexOf("YDS");
    for (const a of passingCat.athletes || []) {
      const yards = ydsIdx >= 0 ? Number(a.stats[ydsIdx]) : null;
      passing.push({
        name: a.athlete.displayName,
        team_abbr: normalizeEspnAbbr(team.team.abbreviation),
        yards: Number.isFinite(yards) ? yards : null,
      });
    }
  }

  const result = { passing };
  cache.set(key, result);
  return result;
}
