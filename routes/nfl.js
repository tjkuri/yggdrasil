// routes/nfl.js
const express = require("express");
const router = express.Router();

const { loadRosterForSeasonPreferCurrent, extractQBs } = require("../services/nflverseRoster");

router.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * GET /api/nfl/qbs?season=2025&active=true&startersOnly=false&limit=0
 * - season: defaults to current year
 * - active: filter to active QBs (default true)
 * - startersOnly: only rows we think are starters (default false)
 * - limit: cap the number returned (0 = no cap)
 */
router.get("/qbs", async (req, res) => {
  try {
    const nowYear = new Date().getFullYear();
    const season = Number(req.query.season) || nowYear;
    const activeOnly = req.query.active !== "false";
    const startersOnly = req.query.startersOnly === "true";
    const limit = Math.max(0, Number(req.query.limit) || 0);

    const rosterRows = await loadRosterForSeasonPreferCurrent(season);
    let qbs = extractQBs(rosterRows);

    if (activeOnly) qbs = qbs.filter((p) => p.isActive);
    if (startersOnly) qbs = qbs.filter((p) => p.isStarter);

    // Sort: starters first, then by team, then name
    qbs.sort((a, b) => {
      if (a.isStarter !== b.isStarter) return a.isStarter ? -1 : 1;
      if (a.team_abbr !== b.team_abbr) return a.team_abbr.localeCompare(b.team_abbr);
      return a.name.localeCompare(b.name);
    });

    if (limit > 0) qbs = qbs.slice(0, limit);

    res.json({ season, players: qbs });
  } catch (err) {
    res.status(500).json({ error: "roster_error", message: err?.message || "Failed to load rosters." });
  }
});

module.exports = router;
