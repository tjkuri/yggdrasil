const express = require('express');
const app = express();

// Set the port number (default: 3000)
const port = process.env.PORT || 3001;

// Start the server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

// Define routes (example route for testing)
app.get('/', (req, res) => {
  res.send('Hello from the Node.js server!');
});

