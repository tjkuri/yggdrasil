const express = require('express');
const router = express.Router(); // Create an Express Router instance
const axios = require('axios');
const fs = require('fs');

const utils = require('../utils/utils');
const ballDontLieAPI = require('../services/ballDontLieApi');
const theOddsApi = require('../services/theOddsApi');

router.get('/testing', async (req, res) => {
    let teamMap = await ballDontLieAPI.getTeamIdMap();
    let gamesToday = await ballDontLieAPI.fetchNbaTodayGames();
    // let game = gamesToday[0]
    // home = game.home_team
    // away = game.away_team
    // console.log(teamMap);
    // home3gram = await getLastThreeGames(home, teamMap[home.split(" ").pop()])

    // console.log(gamesToday)
    // console.log(home3gram);
    console.log(teamMap)
    console.log(gamesToday)
    res.json({});
});  


// Handle GET requests for endpoint `/api/nba/totals`
// Return my line for all games today and whether to take O/U for the lines set by sportsbooks of note.
router.get('/totals', async (req, res) => {
    const reCache = false;
    const cacheFilePath = 'cache/' + utils.getToday10AMEST().slice(0,10) + '-nba-total-odds.json' // get the date for today to use as out filename
    var gamesWithLines;

    if (fs.existsSync(cacheFilePath) && !reCache) {
        console.log('Using cached data from file');
        const cachedOdds = await fs.promises.readFile(cacheFilePath);
        gamesWithLines = JSON.parse(cachedOdds);
    }
    else{
        gamesWithLines = await theOddsApi.fetchNbaTodayLines(cacheFilePath);
    }

    // console.log(gamesWithLines);
    res.json(gamesWithLines);


    // TODO:
    // 3. For each game calculate my line
});

// Export the router to be used in your main server file
module.exports = router;