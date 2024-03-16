const express = require('express');
const axios = require('axios');

const apiKey = process.env.ODDS_API_KEY;
const router = express.Router(); // Create an Express Router instance


var gamesTomorrowConfig = {
    method: 'get',
    url: 'https://api.the-odds-api.com/v4/sports',
    // headers: {},
    params: {
        apiKey
    },
  };


// Example endpoint (replace with your actual logic)
router.get('/bball', async (req, res) => {
    axios.get('https://api.the-odds-api.com/v4/sports/basketball_nba/events', {
        params: {
            apiKey,
            commenceTimeFrom: '2024-03-16T03:30:35Z'
        }
    })
    .then(response => {
        console.log(response.data)
        res.json(response.data)
    })
    .catch(error => {
        console.log('Error status', error.response.status)
        console.log(error.response.data)
    })
});

// Export the router to be used in your main server file
module.exports = router;