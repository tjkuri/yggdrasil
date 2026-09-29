// services/nflOddsPersistence.js
//
// Disk-backed persistence for the two NFL odds-related caches that need to
// survive a server restart: the matchup-event memory (rememberOddsEvent/
// recallOddsEvent in routes/nfl.js) and the captured per-event odds blobs.
// utils/cache.js itself stays in-memory-only and unchanged — this module
// mirrors services/nbaLogger.js's disk-cache pattern, scoped to just these
// two NFL key families, and writes through to disk on every cache.set() the
// caller makes for one of them.

const fs = require("fs");
const path = require("path");
const cache = require("../utils/cache");

const FILE = path.join(__dirname, "../cache/nfl-odds-events.json");

function readAll() {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch (err) {
    console.error("[nflOddsPersistence] failed to read", FILE, err?.message || err);
    return {};
  }
}

function writeAll(all) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2), "utf-8");
}

/** Write-through: persist one key/value pair to disk in addition to the in-memory cache.set() the caller already did. */
function persist(key, value) {
  const all = readAll();
  all[key] = value;
  writeAll(all);
}

/** Call once at module load: repopulate utils/cache.js's in-memory store from disk for any key matching one of the given prefixes. */
function hydrate(keyPrefixes) {
  const all = readAll();
  for (const [key, value] of Object.entries(all)) {
    if (keyPrefixes.some(p => key.startsWith(p))) cache.set(key, value);
  }
}

module.exports = { persist, hydrate };
