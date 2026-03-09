# Yggdrasil
Backend to [Mimir](https://github.com/tjkuri/mimir). 

Currently in development but the goal is to have the mimir repo hold all the frontend react code while this repos code will act as the backend, i.e., handle communication with any 3rd party APIs, stat aggregation, and analysis.

## Further Reading
Have a [Journal.md](JOURNAL.md) file where I try to keep track of some lessons learned and things I want to add in the future (obviously a 'jira'-like system would be more professional for tracking that sort of thing but right now its just me)

## If you want to run this

### .env
Requires the following values in a .env file. NBA game data now comes from the ESPN unofficial API (no key needed). Only The Odds API key is required.
```bash
ODDS_API_KEY=<KEY>
ODDS_HOST=https://api.the-odds-api.com  # optional, defaults to this
```
