const express = require('express');
const router = express.Router(); // Create an Express Router instance
const axios = require('axios');
const fs = require('fs');

const utils = require('../utils/utils');
const ballDontLieAPI = require('../services/ballDontLieApi');
const theOddsApi = require('../services/theOddsApi');

/**
 * Given a BallDontLieAPI JSON representaiton of an NBA game, determine what my line for the total score is
 * @param {object} ballDontLieGame - BallDontLieAPI JSON representaiton of an NBA game
 * @returns {float} - My Line
 */
async function getLastSixScores(ballDontLieGame){
    let teamMap = await ballDontLieAPI.getTeamIdMap();
    let homeTeamName = ballDontLieGame.home_team.full_name
    let awayTeamName = ballDontLieGame.visitor_team.full_name

    // Fetch the last 3 non OT games that each team played in
    let home3gram = await ballDontLieAPI.getLastThreeGames(homeTeamName, teamMap[homeTeamName.split(" ").pop()])
    let away3gram = await ballDontLieAPI.getLastThreeGames(awayTeamName, teamMap[awayTeamName.split(" ").pop()])
    
    const game_total = (game) => game.home_team_score + game.visitor_team_score;

    const lastSix = home3gram.concat(away3gram)
    return lastSix.map(game_total)
}

/**
 * Fetch  JSON representaiton of an NBA games played today with my line inlcuded as a field
 * @returns {Array<object>} - NBA game jsons with my line
 */
async function getTodaysPlays(){
    let gamesToday = await ballDontLieAPI.fetchNbaTodayGames();

    for (let game of gamesToday) {
        const lastSixTotals = await getLastSixScores(game)
        let  myLine = lastSixTotals.reduce((partialSum, a) => partialSum + a, 0) / 6;
        game['myLine'] = myLine.toFixed(2);
        game['lastSix'] = lastSixTotals
    }
    return gamesToday
}

/**
 * Given a home team, return the OddsAPI game from the list of games that matches, false if non is present.
 * @param {Array<object>} oddsApiGames - List of OddsAPI game objects
 * @param {string} homeTeam - Home team name of the desired game to find.
 * @returns {object | boolean} - Game object of the the matching game, false if none is found
 */
function findOddsApiGameByHomeTeam(oddsApiGames, homeTeam) {
    for (const game of oddsApiGames) {
      if (game.home_team.split(" ").pop() === homeTeam.split(" ").pop()) {
        return game;
      }
    }
    return false;
  }

  /**
   * Write the stringified data to the sepcified file
   * @param {*} data - Data to be cached
   * @param {*} file_name - Path to file where data should be cached
   */
async function addToCache(data, file_name){
    await fs.promises.writeFile(file_name, JSON.stringify(data), 'utf-8');
    //TODO: should probably add some error catching here?
}

/**
 * Retrieve data from the specified file cache
 * @param {*} file_path 
 * @returns {object} data at the specified path if it exists, false otherwise
 */
async function retrieveFromCache(file_path){
    if (fs.existsSync(file_path)) {
        console.log('Using cached data from file');
        const cachedData = await fs.promises.readFile(file_path);
        return JSON.parse(cachedData);
    }
    return false;
}

// misc. endpoint used for testing and dev
router.get('/testing', async (req, res) => {
    let foo = await getTodaysPlays();
    res.json(foo);
});  


// Handle GET requests for endpoint `/api/nba/totals`
// Return Every NBA game for today with my line and the sportsbook lines
router.get('/totals', async (req, res) => {
    // await new Promise(resolve => setTimeout(resolve, 5000)); //TODO: REMOVE, only using this for frontend testing

    const reCache = false;
    const oddsFilePath = 'cache/' + utils.getToday10AMEST().slice(0,10) + '-nba-total-odds.json' // get the date for today to use as out filename
    var gamesVegasLines = await retrieveFromCache(oddsFilePath)

    if (gamesVegasLines && !reCache) {
        console.log('Using cached data from:' + oddsFilePath);
    }
    else{
        gamesVegasLines = await theOddsApi.fetchNbaTodayLines();
        addToCache(gamesVegasLines, oddsFilePath)
    }


    const myLineFilePath = 'cache/' + utils.getToday10AMEST().slice(0,10) + '-nba-my-lines.json' // get the date for today to use as out filename
    let gamesMyLines = await retrieveFromCache(myLineFilePath);
    if (gamesMyLines && !reCache) {
        console.log('Using cached data from:' + myLineFilePath);
    }
    else{
        gamesMyLines = await getTodaysPlays();
        addToCache(gamesMyLines, myLineFilePath)
    }

    for (let game of gamesMyLines) {
        matchingGame = findOddsApiGameByHomeTeam(gamesVegasLines, game.home_team.full_name)
        let draftkingsLine = false
        if(matchingGame){
            let draftkingsOdds = matchingGame.bookmakers.filter((book) => book.key === 'draftkings')
            draftkingsLine = draftkingsOdds.length > 0 ? draftkingsOdds[0].markets[0].outcomes[0].point : false
        }
        game['draftkings_line'] = draftkingsLine
    } 

    // console.log(gamesMyLines)
    res.json(gamesMyLines);
});

// Export the router to be used in your main server file
module.exports = router;