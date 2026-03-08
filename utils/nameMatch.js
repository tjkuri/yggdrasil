// utils/nameMatch.js
// Shared player name normalization and fuzzy-matching across NFL routes and services.

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[,.''""\-]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitName(s) {
  const parts = normalizeName(s).split(" ");
  return { first: parts[0] || "", last: parts[parts.length - 1] || "" };
}

/**
 * True when two player name strings refer to the same person.
 * Handles abbreviated first names like "P. Mahomes" ↔ "Patrick Mahomes".
 */
function isSamePlayer(nameA, nameB) {
  const a = splitName(nameA);
  const b = splitName(nameB);
  if (!a.last || !b.last) return false;
  if (a.last !== b.last) return false;
  return (
    a.first === b.first ||
    (a.first && b.first && a.first[0] === b.first[0]) ||
    a.first.startsWith(b.first) ||
    b.first.startsWith(a.first)
  );
}

module.exports = { normalizeName, splitName, isSamePlayer };
