const express = require('express');
const nbaAPI = require('./routes/nba'); //modules for handling request to /api/nba endpoint

require('dotenv').config(); //allows us to import variables from .env

//create our server app
const app = express();

// Set the port number (default: 3001)
const port = process.env.PORT || 3001;

// Mount the router on the desired path (optional, defaults to '/')
app.use('/api/nba', nbaAPI);

// Example Hello World route
app.get('/', (req, res) => {
  res.send('Hello from the Node.js server!');
});

// Start the server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
