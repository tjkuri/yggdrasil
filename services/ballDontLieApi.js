const axios = require('axios');
const utils = require('../utils/utils');


require('dotenv').config(); //allows us to import variables from .env
const ballDontLieKey = process.env.BALLDONTLIE_KEY;

module.exports = {
    fetchNbaTodayGames, getLastThreeGames, getTeamIdMap
};

/**
 * TODO
 * @returns {Array<Dict>} - TODO
 * @throws {Error} - TODO
 */
async function fetchNbaTodayGames() {
    // config with request params
    const requestConfig = {
        headers: {
            Authorization: ballDontLieKey,
        },
        params: {
            per_page: 25,
            seasons: [2023], // need this here otherwise itll return a bunch of empty pages. looks like inseason tourny is included
            dates: [utils.getToday10AMEST().slice(0, 10)],
        }
    }

    try {
        console.log('Getting NBA Games for ' + requestConfig.params.dates)
        const response = await axios.get('https://api.balldontlie.io/v1/games', requestConfig);
        const data = response.data.data
        const meta = response.data.meta

        if (meta.next_cursor) { console.log('Not all game data fetched, possible result is not accurate') }
        return data

    } catch (error) { // Handle errors appropriately (e.g., throw an error or return a default value)
        console.error(error);
        throw error; // Re-throw the error to allow callers to handle it
    }
}

var teamIdMap = {}
/**
 * Build a mapping from team name to id in the BallDontLie API
 * @returns {Dict} mapping from team full name to id
 */
async function getTeamIdMap() {
    const requestConfig = {
        headers: {
            Authorization: ballDontLieKey,
        },
    }
    try {
        if (Object.keys(teamIdMap).length != 0) {
            console.log('Ball Dont Lie Map, already built');
            return teamIdMap;
        }

        const response = await axios.get('https://api.balldontlie.io/v1/teams', requestConfig);
        const data = response.data.data; //the response has a data field within the data

        //response returns all nba teams, even those that dont exist anymore. 
        //Check if the conference field is non empty to filter out depricated teams.
        let currentTeams = data.filter((team) => team.conference.trim().length > 0);
        let nameToID = {}

        for (const team of currentTeams) {
            nameToID[team.full_name.split(" ").pop()] = team.id
        }
        teamIdMap = nameToID
        return teamIdMap;

    } catch (error) {
        console.error('Error fetching or caching data:', error);
        throw error; // Re-throw to allow handling by caller
    }
}

async function getLastThreeGames(teamFullName, teamId) {
    const requestConfig = {
        headers: {
            Authorization: ballDontLieKey,
        },
        params: {
            team_ids: [teamId],
            per_page: 100,
            seasons: [2023], // need this here otherwise itll return a bunch of empty pages. looks like inseason tourny is included
            end_date: utils.getYesterdayUTC(), // games that occurred on or before today
        }
    }
    try {
        baseUrl = 'https://api.balldontlie.io/v1/games'
        console.log('Getting totals for ' + teamFullName + ' with id: ' + teamId + ' up through ' + requestConfig.params.end_date)
        const response = await axios.get('https://api.balldontlie.io/v1/games', requestConfig);
        const data = response.data.data
        const meta = response.data.meta

        if (meta.next_cursor) { console.log('Not all game data fetched, possible result is not accurate') }

        // Filter data with status 4
        const filteredData = data.filter((game) => game.status === 'Final');

        // Sort by date in descending order (recent first)
        filteredData.sort((a, b) => new Date(b.date) - new Date(a.date));

        // Get the most recent 3 objects
        return filteredData.slice(0, 3);

    } catch (error) {
        console.error('Error fetching or caching data:', error);
        throw error; // Re-throw to allow handling by caller
    }
}