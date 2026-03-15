#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const nbaLogger = require('../services/nbaLogger');

async function main() {
  console.log('NBA backfill — checking last 4 days...\n');
  const summary = await nbaLogger.backfillLastNDays(4);
  console.log('\nSummary:');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
