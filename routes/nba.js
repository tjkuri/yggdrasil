const express = require('express');
const router = express.Router(); // Create an Express Router instance
const axios = require('axios');
const fs = require('fs');

const utils = require('../utils/utils');
const ballDontLieAPI = require('../services/ballDontLieApi');
const theOddsApi = require('../services/theOddsApi');

/**
 * 
 * @param {*} ballDontLieGame 
 * @returns {number}
 */
async function getMyLine(ballDontLieGame){
    let teamMap = await ballDontLieAPI.getTeamIdMap();
    let homeTeamName = ballDontLieGame.home_team.full_name
    let awayTeamName = ballDontLieGame.visitor_team.full_name

    let home3gram = await ballDontLieAPI.getLastThreeGames(homeTeamName, teamMap[homeTeamName.split(" ").pop()])
    let away3gram = await ballDontLieAPI.getLastThreeGames(awayTeamName, teamMap[awayTeamName.split(" ").pop()])
    
    const game_total = (game) => game.home_team_score + game.visitor_team_score;
    
    totalA = home3gram.map(game_total).reduce((partialSum, a) => partialSum + a, 0);
    totalB = away3gram.map(game_total).reduce((partialSum, a) => partialSum + a, 0);
  
    return (totalA + totalB) / 6
}

router.get('/testing', async (req, res) => {
    let gamesToday = await ballDontLieAPI.fetchNbaTodayGames();

    for (let game of gamesToday) {
        const myLine = await getMyLine(game)
        game['myLine'] = myLine
    }
    console.log(gamesToday)
    res.json(gamesToday);
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
});

// Export the router to be used in your main server file
module.exports = router;