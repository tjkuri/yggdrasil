const express = require('express');
const nbaRoutes = require('./routes/nba'); //modules for handling request to /api/nba endpoint
const nflRoutes = require("./routes/nfl"); //TODO


require('dotenv').config(); //allows us to import variables from .env

//create our server app
const app = express();

// Set the port number (default: 3001)
const port = process.env.PORT || 3001;

app.use(function (req, res, next) {
  res.header('Access-Control-Allow-Origin', "http://localhost:3000"); //TODO: change this is if we deploy
  res.header('Access-Control-Allow-Headers',
      'Content-Type, X-Requested-With, Origin');
  res.header('Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

// Mount the router on the desired path (optional, defaults to '/')
app.use('/api/nba', nbaRoutes);
// TODO
app.use("/api/nfl", nflRoutes);


// Example Hello World route
app.get('/', (req, res) => {
  res.send('Hello from the Node.js server!');
});

// Start the server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
