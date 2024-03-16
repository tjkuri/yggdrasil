const express = require('express');
const router = express.Router(); // Create an Express Router instance
const axios = require('axios');

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

// Handle GET requests for endpoint `/api/nba/totals`
// 1. Fetch NBA games scheduled for today
// 2.
// 3.
router.get('/totals', async (req, res) => {
    const gamesToday = await fetchNbaTodayGames()
    console.log(gamesToday)
    res.json(gamesToday)
    
    // TODO:
    // 2. For each game add the over under line that the relevanat bookmakers have
    // 3. For each game calculate my line
    // any math 
});

// Export the router to be used in your main server file
module.exports = router;