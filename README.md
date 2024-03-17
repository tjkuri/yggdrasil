# Yggdrasil
Backend to [Mimir](https://github.com/tjkuri/mimir). 

Currently in development but the goal is to have the mimir repo hold all the frontend react code while this repos code will act as the backend, i.e., handle communication with any 3rd party APIs, stat aggregation, and analysis.

### .env
Requires the following values in a .env file. The keys are for api services: [odds-api](https://the-odds-api.com) and [balldontlie](https://www.balldontlie.io/#introduction)
```bash
# will need to get api keys for each of these services
BALLDONTLIE_KEY=<KEY>
ODDS_API_KEY=<KEY>
```
