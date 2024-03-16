const express = require('express');
const axios = require('axios');

const apiKey = process.env.API_KEY;
const router = express.Router(); // Create an Express Router instance


var gamesTomorrowConfig = {
    method: 'get',
    url: 'https://v2.nba.api-sports.io/games',
    qs: {
        date: '2024-03-16',
        league: 'standard',
        season: '2023'
    },
    headers: {
      'x-apisports-key': apiKey,
    }
  };


// Example endpoint (replace with your actual logic)
router.get('/ngram', async (req, res) => {
  try {
    // Make a call to the 3rd party API using Axios
    const response = await axios.get(gamesTomorrowConfig);
    const externalData = response.data;

    // Perform your logic on the external data
    console.log(externalData)

    // Send the processed data as the response
    res.json(externalData);
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error'); // Handle errors appropriately
  }
});

// Export the router to be used in your main server file
module.exports = router;