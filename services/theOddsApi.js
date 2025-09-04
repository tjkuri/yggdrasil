const axios = require('axios');
const utils = require('../utils/utils');
const fs = require('fs');

require('dotenv').config(); //allows us to import variables from .env
const oddsApiKey = process.env.ODDS_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_HOST = process.env.ODDS_HOST || "https://api.the-odds-api.com";

module.exports = {
    fetchNbaTodayGames, fetchNbaTodayLines, listNflEvents, getEventOdds
};

/**
 * Free: list in-play & pre-match events (home/away/commence_time/id).
 * 0 credits per docs.
 */
async function listNflEvents() {
  if (!ODDS_API_KEY) throw new Error("Missing ODDS_API_KEY");
  const url = `${ODDS_HOST}/v4/sports/americanfootball_nfl/events`;
  const res = await axios.get(url, { params: { apiKey: ODDS_API_KEY } });
  return { data: res.data, headers: res.headers };
}

/**
 * Paid: one event, one market, one region (1 credit).
 * We ask only for player_pass_yds in region 'us' to keep costs minimal.
 */
async function getEventOdds(eventId, { market = "player_pass_yds", regions = "us", oddsFormat = "american" } = {}) {
  if (!ODDS_API_KEY) throw new Error("Missing ODDS_API_KEY");
  const url = `${ODDS_HOST}/v4/sports/americanfootball_nfl/events/${eventId}/odds`;
  const res = await axios.get(url, {
    params: { apiKey: ODDS_API_KEY, regions, markets: market, oddsFormat }
  });
  return { data: res.data, headers: res.headers };
}



/**
 * Use Odds-API to fetch a list of NBA games scheduled for today (start time is between 10AM - 1130PM)
 * @returns {Array<object>} List of jsons each representing an NBA game scheduled for today
 * @throws {Error} - if the try statement throws an error, it is logged and raised again for callers to handle
 */
async function fetchNbaTodayGames() {
    // config with request params
    var requestConfig = {
        params: {
            apiKey: oddsApiKey,
            commenceTimeFrom: utils.getToday10AMEST(),
            commenceTimeTo: utils.getToday1130PMEST(),
            // dateFormat: 'unix'
        },
      }

    try {
        console.log('Fetching NBA games Today from odd-api')
        const response = await axios.get('https://api.the-odds-api.com/v4/sports/basketball_nba/events', requestConfig)
        console.log(requestConfig.params)
        console.log('Remaining requests',response.headers['x-requests-remaining'])
        console.log('Used requests',response.headers['x-requests-used'])
        return response.data; // Return the data from the API response
    } catch (error) { // Handle errors appropriately (e.g., throw an error or return a default value)
        console.error(error);
        throw error; // Re-throw the error to allow callers to handle it
    }
  }


/**
 * Fetch the games and total point lines in the NBA today. NOTE: only returns games where bookmakers
 * still have lines open
 * @returns {Array<object>} List of jsons each representing an NBA game scheduled for today that had open lines
 */
async function fetchNbaTodayLines() {
    var requestConfig = {
        params: {
            apiKey: oddsApiKey,
            commenceTimeFrom: utils.getToday10AMEST(),
            commenceTimeTo: utils.getToday1130PMEST(),
            regions: 'us',
            markets: 'totals',
            oddsFormat: 'american',
            bookmakers: 'betmgm,draftkings,fanduel',
        },
      }
    try {
        console.log('Fetching NBA Totals odds from odd-api')
        const response = await axios.get('https://api.the-odds-api.com/v4/sports/basketball_nba/odds',requestConfig);
        const data = response.data;

        console.log(data)
        console.log(requestConfig.params)
        console.log('Remaining requests',response.headers['x-requests-remaining'])
        console.log('Used requests',response.headers['x-requests-used'])
        return data;

    } catch (error) {
        console.error('Error fetching or caching data:', error);
        throw error; // Re-throw to allow handling by caller
    }
}