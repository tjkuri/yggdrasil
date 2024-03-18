const express = require('express');
const router = express.Router(); // Create an Express Router instance
const axios = require('axios');
const fs = require('fs');

const utils = require('../utils/utils');
const ballDontLieAPI = require('../services/ballDontLieApi');
const theOddsApi = require('../services/theOddsApi');

/**
 * Given a BallDontLieAPI JSON representaiton of an NBA game, determine what my line for the total score is
 * @param {json} ballDontLieGame - BallDontLieAPI JSON representaiton of an NBA game
 * @returns {number} My line
 */
async function getMyLine(ballDontLieGame){
    let teamMap = await ballDontLieAPI.getTeamIdMap();
    let homeTeamName = ballDontLieGame.home_team.full_name
    let awayTeamName = ballDontLieGame.visitor_team.full_name

    // Fetch the last 3 non OT games that each team played in
    let home3gram = await ballDontLieAPI.getLastThreeGames(homeTeamName, teamMap[homeTeamName.split(" ").pop()])
    let away3gram = await ballDontLieAPI.getLastThreeGames(awayTeamName, teamMap[awayTeamName.split(" ").pop()])
    
    const game_total = (game) => game.home_team_score + game.visitor_team_score;
    
    totalA = home3gram.map(game_total).reduce((partialSum, a) => partialSum + a, 0);
    totalB = away3gram.map(game_total).reduce((partialSum, a) => partialSum + a, 0);
    
    // Return the average of the last three games of each team
    return (totalA + totalB) / 6
}

/**
 * Fetch  JSON representaiton of an NBA games played today with my line inlcuded as a field
 * @returns NBA game jsons with my line
 */
async function getTodayMyLines(){
    let gamesToday = await ballDontLieAPI.fetchNbaTodayGames();

    for (let game of gamesToday) {
        const myLine = await getMyLine(game)
        game['myLine'] = myLine
    }
    // console.log(gamesToday)
    return gamesToday
}

/**
 * TODO
 * @param {*} oddsApiGames 
 * @param {*} homeTeam 
 * @returns 
 */
function findOddsApiGameByHomeTeam(oddsApiGames, homeTeam) {
    for (const game of oddsApiGames) {
      if (game.home_team.split(" ").pop() === homeTeam.split(" ").pop()) {
        return game;
      }
    }
    return false;
  }

// misc. endpoint used for testing and dev
router.get('/testing', async (req, res) => {
    let foo = await getTodayMyLines();
    res.json(foo);
});  


// Handle GET requests for endpoint `/api/nba/totals`
// Return Every NBA game for today with my line and the sportsbook lines
router.get('/totals', async (req, res) => {
    const reCache = false;
    const cacheFilePath = 'cache/' + utils.getToday10AMEST().slice(0,10) + '-nba-total-odds.json' // get the date for today to use as out filename
    var gamesVegasLines;

    if (fs.existsSync(cacheFilePath) && !reCache) {
        console.log('Using cached data from file');
        const cachedOdds = await fs.promises.readFile(cacheFilePath);
        gamesVegasLines = JSON.parse(cachedOdds);
    }
    else{
        gamesVegasLines = await theOddsApi.fetchNbaTodayLines(cacheFilePath);
    }

    let gamesMyLines = await getTodayMyLines();

    for (let game of gamesMyLines) {
        matchingGame = findOddsApiGameByHomeTeam(gamesVegasLines, game.home_team.full_name)
        game['bookmakers'] = matchingGame.bookmakers
    } 

    console.log(gamesMyLines)
    res.json(gamesMyLines);
});

// Export the router to be used in your main server file
module.exports = router;