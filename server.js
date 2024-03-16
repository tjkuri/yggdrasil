const express = require('express');
const app = express();
require('dotenv').config();


const basketballTotalApi = require('./routes/basketball-totals'); // Assuming your file path

// Set the port number (default: 3000)
const port = process.env.PORT || 3001;

// Mount the router on the desired path (optional, defaults to '/')
app.use('/basketball', basketballTotalApi);

// Define routes (example route for testing)
app.get('/', (req, res) => {
  res.send('Hello from the Node.js server!');
});

// Start the server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
