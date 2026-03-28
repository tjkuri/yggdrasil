const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const { fetchMlbOdds } = require('../services/theOddsApi');

const CACHE_DIR = path.join(__dirname, '../cache');

// ─── File cache helpers ───────────────────────────────────────────────────────

async function addToCache(data, filePath) {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function retrieveFromCache(filePath) {
  if (fs.existsSync(filePath)) {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  }
  return null;
}

/** Convert a UTC commence_time to an ET date string (YYYY-MM-DD). */
function gameDay(commenceTime) {
  return new Date(commenceTime).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── Opening snapshot merge (per-day) ─────────────────────────────────────────

async function mergeOpeningSnapshot(dayGames, openFilePath, now) {
  const existingOpen = await retrieveFromCache(openFilePath);
  if (!existingOpen) {
    await addToCache(dayGames, openFilePath);
    return { action: 'seeded', count: dayGames.length };
  }

  const openById = Object.fromEntries(existingOpen.map(g => [g.id, g]));
  let filled = 0;
  for (const fresh of dayGames) {
    const existing = openById[fresh.id];
    const freshHasMarkets = fresh.bookmakers?.[0]?.markets?.length > 0;
    const existingHasMarkets = existing?.bookmakers?.[0]?.markets?.length > 0;
    // Backfill empty → non-empty, but only if game is still pre-game
    if (!existingHasMarkets && freshHasMarkets && new Date(fresh.commence_time) > now) {
      openById[fresh.id] = fresh;
      filled++;
    }
    // New game not in snapshot yet — add if pre-game
    if (!existing && new Date(fresh.commence_time) > now) {
      openById[fresh.id] = fresh;
      filled++;
    }
  }
  if (filled > 0) {
    await addToCache(Object.values(openById), openFilePath);
    return { action: 'backfilled', count: filled };
  }
  return { action: 'unchanged', count: 0 };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/mlb/odds?refreshOdds=true
router.get('/odds', async (req, res) => {
  try {
    const refreshOdds = req.query.refreshOdds === 'true';
    const now = new Date();

    // If not refreshing, return all cached day files
    if (!refreshOdds) {
      const cached = loadCachedDays();
      if (cached.length > 0) {
        return res.json({ days: cached });
      }
      // Nothing cached yet — fall through to fetch
    }

    console.log('[mlb/odds] Fetching MLB odds from The Odds API');
    const { data, headers } = await fetchMlbOdds();

    // Filter to future games only
    const futureGames = data.filter(g => new Date(g.commence_time) > now);
    console.log(`[mlb/odds] ${data.length} total, ${futureGames.length} future`);
    console.log(`[mlb/odds] x-requests-remaining: ${headers['x-requests-remaining']}`);

    // Group by game day (ET)
    const byDay = {};
    for (const game of futureGames) {
      const day = gameDay(game.commence_time);
      (byDay[day] ||= []).push(game);
    }

    // Write per-day cache files + merge opening snapshots
    const summary = [];
    for (const [day, dayGames] of Object.entries(byDay).sort()) {
      const sorted = dayGames.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
      const oddsFile = path.join(CACHE_DIR, `${day}-mlb-odds.json`);
      const openFile = path.join(CACHE_DIR, `${day}-mlb-odds-open.json`);

      await addToCache(sorted, oddsFile);
      const openResult = await mergeOpeningSnapshot(sorted, openFile, now);
      console.log(`[mlb/odds] ${day}: ${sorted.length} games, opening ${openResult.action} (${openResult.count})`);

      summary.push({
        date: day,
        game_count: sorted.length,
        opening_status: openResult.action,
      });
    }

    // Return all cached days (includes what we just wrote + any prior days)
    res.json({ days: loadCachedDays() });
  } catch (err) {
    console.error('[mlb/odds]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Scan cache dir for all mlb-odds files, return grouped by day. */
function loadCachedDays() {
  const files = fs.readdirSync(CACHE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}-mlb-odds\.json$/.test(f)).sort();
  return files.map(f => {
    const day = f.slice(0, 10);
    const oddsFile = path.join(CACHE_DIR, f);
    const openFile = path.join(CACHE_DIR, `${day}-mlb-odds-open.json`);
    const games = JSON.parse(fs.readFileSync(oddsFile, 'utf-8'));
    return {
      date: day,
      game_count: games.length,
      games,
      has_opening_snapshot: fs.existsSync(openFile),
      cached_at: fs.statSync(oddsFile).mtime.toISOString(),
    };
  });
}

module.exports = router;
