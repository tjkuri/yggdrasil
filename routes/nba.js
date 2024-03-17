const express = require('express');
const router = express.Router(); // Create an Express Router instance
const axios = require('axios');
const fs = require('fs');

const oddsApiKey = process.env.ODDS_API_KEY;
const ballDontLieKey = process.env.BALLDONTLIE_KEY;

/**
 * ISO8601 formatted string representing 10 a.m. EST Today, e.g., YYYY-MM-DDTHH:MM:SSZ
 * @returns {String} ISO8601 string for 10 a.m. EST Today
 */
function getToday10AMEST() {
    const today = new Date();
    today.setHours(10, 0, 0); // Set the time to 10:00 AM
    const utcString = today.toISOString(); // Get the UTC representation of the date
    return utcString.slice(0, 19) + 'Z'
}

/**
 * ISO8601 formatted string representing 11:30 p.m. EST Today, e.g., YYYY-MM-DDTHH:MM:SSZ
 * @returns {String} ISO8601 string for 11:30 p.m. EST Today
 */
function getToday1130PMEST() {
    const today = new Date();
    today.setHours(23, 30, 0); // Set the time to 10:00 AM
    const utcString = today.toISOString(); // Get the UTC representation of the date
    return utcString.slice(0, 19) + 'Z'
  }
  
/**
 * Use Odds-API to fetch a list of NBA games scheduled for today (start time is between 10AM - 1130PM)
 * @returns {Array<Dict>} List of jsons each representing an NBA game scheduled for today
 * @throws {Error} - if the try statement throws an error, it is logged and raised again for callers to handle
 */
async function fetchNbaTodayGames() {
    // config with request params
    var requestConfig = {
        params: {
            apiKey: 'cadebdc317940567fa1d9b1113954be0',
            commenceTimeFrom: getToday10AMEST(),
            commenceTimeTo: getToday1130PMEST(),
            dateFormat: 'unix'
        },
      }

    try {
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
 * @param {*} cacheFilePath File path where to cache api response
 * @returns {Array<Dict>} List of jsons each representing an NBA game scheduled for today that had open lines
 */
async function fetchNbaTodayLines(cacheFilePath) {
    var requestConfig = {
        params: {
            apiKey: 'cadebdc317940567fa1d9b1113954be0',
            commenceTimeFrom: getToday10AMEST(),
            commenceTimeTo: getToday1130PMEST(),
            regions: 'us',
            markets: 'totals',
            oddsFormat: 'american',
            bookmakers: 'betmgm,draftkings,fanduel',
        },
      }
    try {
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
  

// Handle GET requests for endpoint `/api/nba/totals`
router.get('/totals', async (req, res) => {
    const reCache = false;
    const cacheFilePath = 'cache/' + getToday10AMEST().slice(0,10) + '-nba-total-odds.json' // get the date for today to use as out filename
    
    if (fs.existsSync(cacheFilePath) && !reCache) {
        console.log('Using cached data from file');
        const cachedOdds = await fs.promises.readFile(cacheFilePath);
        let gamesWithLines = JSON.parse(cachedOdds);
        // console.log(gamesWithLines);
        res.json(gamesWithLines);
    }
    else{
        let gamesWithLines = await fetchNbaTodayLines(cacheFilePath);
        // console.log(gamesWithLines);
        res.json(gamesWithLines);
    }


    // TODO:
    // 3. For each game calculate my line
});

// Export the router to be used in your main server file
module.exports = router;