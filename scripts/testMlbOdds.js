const axios = require('axios');
require('dotenv').config();

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_HOST = process.env.ODDS_HOST || 'https://api.the-odds-api.com';

async function run() {
  if (!ODDS_API_KEY) {
    console.error('Missing ODDS_API_KEY in .env');
    process.exit(1);
  }

  // 1. Confirm the MLB sport key
  console.log('--- Fetching active sports ---');
  const sportsRes = await axios.get(`${ODDS_HOST}/v4/sports`, {
    params: { apiKey: ODDS_API_KEY }
  });
  const mlb = sportsRes.data.find(s => s.key === 'baseball_mlb');
  if (mlb) {
    console.log(`Found: ${mlb.key} — "${mlb.title}" (active: ${mlb.active})`);
  } else {
    console.log('baseball_mlb not found in active sports. Available baseball sports:');
    sportsRes.data.filter(s => s.group === 'Baseball').forEach(s =>
      console.log(`  ${s.key} — ${s.title} (active: ${s.active})`)
    );
    console.log('\nFull sport keys:', sportsRes.data.map(s => s.key).join(', '));
    return;
  }

  // 2. Fetch MLB odds — h2h + totals + spreads, DraftKings only
  console.log('\n--- Fetching MLB odds (h2h, totals, spreads) ---');
  const oddsRes = await axios.get(`${ODDS_HOST}/v4/sports/baseball_mlb/odds`, {
    params: {
      apiKey: ODDS_API_KEY,
      regions: 'us',
      markets: 'h2h,totals,spreads',
      oddsFormat: 'american',
      bookmakers: 'draftkings',
    }
  });

  const games = oddsRes.data;
  console.log(`Games found: ${games.length}`);
  console.log(`x-requests-remaining: ${oddsRes.headers['x-requests-remaining']}`);
  console.log(`x-requests-used: ${oddsRes.headers['x-requests-used']}`);

  if (games.length === 0) {
    console.log('No games returned — season may not be active yet.');
    return;
  }

  // 3. Log a sample game with all three markets
  const sample = games[0];
  console.log(`\n--- Sample game ---`);
  console.log(`${sample.away_team} @ ${sample.home_team}`);
  console.log(`Commence: ${sample.commence_time}`);
  console.log(`ID: ${sample.id}`);

  if (sample.bookmakers && sample.bookmakers.length > 0) {
    const dk = sample.bookmakers[0];
    console.log(`\nBookmaker: ${dk.title}`);
    for (const market of dk.markets) {
      console.log(`\n  Market: ${market.key}`);
      for (const outcome of market.outcomes) {
        const parts = [`    ${outcome.name}`];
        if (outcome.point !== undefined) parts.push(`point: ${outcome.point}`);
        parts.push(`price: ${outcome.price}`);
        console.log(parts.join('  |  '));
      }
    }
  } else {
    console.log('No bookmaker data for this game.');
  }
}

run().catch(err => {
  console.error('Error:', err.response?.data || err.message);
  process.exit(1);
});
