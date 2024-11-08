# Yggdrasil
Backend to [Mimir](https://github.com/tjkuri/mimir). 

Currently in development but the goal is to have the mimir repo hold all the frontend react code while this repos code will act as the backend, i.e., handle communication with any 3rd party APIs, stat aggregation, and analysis.

## Further Reading
Have a [Journal.md](JOURNAL.md) file where I try to keep track of some lessons learned and things I want to add in the future (obviously a 'jira'-like system would be more professional for tracking that sort of thing but right now its just me)

## If you want to run this

### .env
Requires the following values in a .env file. The keys are for api services: [odds-api](https://the-odds-api.com) and [balldontlie](https://www.balldontlie.io/#introduction)
Also need to specify the current nba season (e.g. 2024-2025 season would need 2024 as the value) as it is needed in some of the API calls.
```bash
# will need to get api keys for each of these services
BALLDONTLIE_KEY=<KEY>
ODDS_API_KEY=<KEY>
NBA_SEASON=<YEAR>  #defaults to 2024
```
