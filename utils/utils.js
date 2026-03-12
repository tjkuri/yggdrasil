/**
 * Returns the NBA "sports day" date as YYYY-MM-DD in Eastern Time.
 * Rolls over at 4 AM ET instead of midnight so late West Coast games
 * (tipping off at 10:30 PM ET, ending ~1 AM ET) stay on the correct slate.
 *
 * Implementation: subtract 4 hours from now, then format in America/New_York.
 * Handles EST/EDT automatically via the IANA timezone database.
 *
 *   12:10 AM ET → shifted = 8:10 PM ET (prev day)  → returns prev day  ✓
 *    3:59 AM ET → shifted = 11:59 PM ET (prev day) → returns prev day  ✓
 *    4:00 AM ET → shifted = midnight ET (today)     → returns today     ✓
 */
function getSportsDayEST() {
  const shifted = new Date(Date.now() - 4 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(shifted);
}

/**
 * UTC ISO string for the start of today's NBA slate (10 AM ET of the sports day).
 * Used as commenceTimeFrom for The Odds API. Games never start before noon ET.
 * Hardcodes EST offset (-5h → 15:00 UTC); the ±1h DST imprecision is harmless.
 */
function getSportsDayStartISO() {
  const day = getSportsDayEST();
  return `${day}T15:00:00Z`; // 10 AM ET (EST) = 15:00 UTC
}

/**
 * UTC ISO string for the end of today's NBA slate (07:00 UTC the next calendar day,
 * ≈ 2–3 AM ET). Used as commenceTimeTo for The Odds API.
 * Captures all games that START today, including 10:30 PM ET tip-offs.
 */
function getSportsDayEndISO() {
  const day = getSportsDayEST();
  const next = new Date(day + 'T12:00:00Z'); // noon UTC — safe anchor for date arithmetic
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10) + 'T07:00:00Z';
}

module.exports = { getSportsDayEST, getSportsDayStartISO, getSportsDayEndISO };
