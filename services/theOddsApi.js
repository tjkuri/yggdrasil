const axios = require('axios');
const utils = require('../utils/utils');

require('dotenv').config(); //allows us to import variables from .env
const oddsApiKey = process.env.ODDS_API_KEY;

module.exports = {
    fetchNbaTodayGames, fetchNbaTodayLines
};

/**
 * Use Odds-API to fetch a list of NBA games scheduled for today (start time is between 10AM - 1130PM)
 * @returns {Array<Dict>} List of jsons each representing an NBA game scheduled for today
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
 * @param {string} cacheFilePath File path where to cache api response
 * @returns {Array<Dict>} List of jsons each representing an NBA game scheduled for today that had open lines
 */
async function fetchNbaTodayLines(cacheFilePath) {
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

        await fs.promises.writeFile(cacheFilePath, JSON.stringify(data), 'utf-8');
        console.log('Data fetched and cached to file');

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