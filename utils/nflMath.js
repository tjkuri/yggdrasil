// utils/nflMath.js
// Statistical helpers for NFL distribution analysis.

function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}

/** Accepts unsorted input; filters non-numbers and sorts internally. */
function median(nums) {
  const arr = nums.filter(n => typeof n === "number").sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/** Linear-interpolation quantile. Requires a pre-sorted array. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function stdevSample(arr) {
  const m = mean(arr);
  if (m == null || arr.length < 2) return null;
  const variance = arr.reduce((s, x) => s + Math.pow(x - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function percentileOfValue(sorted, x) {
  if (!sorted.length || x == null) return null;
  let count = 0;
  for (const v of sorted) if (v <= x) count++;
  return count / sorted.length;
}

// Bin count: clamp sqrt(n) between 8 and 20
function buildHistogram(values) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ start: min, end: min, count: values.length }];
  const numBins = Math.min(20, Math.max(8, Math.ceil(Math.sqrt(values.length))));
  const width = (max - min) / numBins;
  const edges = Array.from({ length: numBins + 1 }, (_, i) => min + i * width);
  const counts = Array(numBins).fill(0);
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx >= numBins) idx = numBins - 1; // clamp max value into last bin
    counts[idx]++;
  }
  return counts.map((c, i) => ({
    start: Number(edges[i].toFixed(1)),
    end: Number(edges[i + 1].toFixed(1)),
    count: c,
  }));
}

/**
 * Full per-scope statistical summary: percentiles, histogram, over/under probs, z-score.
 * @param {number[]} values - Raw (unsorted) game values
 * @param {number|null} line - The betting line to compare against
 */
function summarize(values, line) {
  const vals = values.slice().sort((a, b) => a - b);
  const n = vals.length;
  const mu = mean(vals);
  const med = median(vals);
  const sd = stdevSample(vals);
  const fmt1 = v => v != null ? Number(v.toFixed(1)) : null;

  let p_over = null, p_under = null, z_score = null, percentile = null;
  if (n && line != null) {
    p_over = vals.filter(v => v > line).length / n;
    p_under = vals.filter(v => v < line).length / n;
    if (sd && sd > 0 && mu != null) z_score = Number(((line - mu) / sd).toFixed(2));
    percentile = percentileOfValue(vals, line);
  }

  return {
    n,
    mean:      fmt1(mu),
    median:    fmt1(med),
    stdev:     fmt1(sd),
    p10:       fmt1(quantile(vals, 0.10)),
    p25:       fmt1(quantile(vals, 0.25)),
    p50:       fmt1(quantile(vals, 0.50)),
    p75:       fmt1(quantile(vals, 0.75)),
    p90:       fmt1(quantile(vals, 0.90)),
    min: n ? vals[0] : null,
    max: n ? vals[n - 1] : null,
    histogram: buildHistogram(vals),
    p_over,
    p_under,
    z_score,
    percentile: percentile != null ? Number((percentile * 100).toFixed(1)) : null,
  };
}

/**
 * Compute consensus line and dispersion stats from an array of book entries.
 * @param {Array<{point: number}>} books
 */
function computeMarketDispersion(books) {
  const points = books.map(b => b.point).filter(n => typeof n === "number");
  const sorted = points.slice().sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const points_min = sorted.length ? sorted[0] : null;
  const points_max = sorted.length ? sorted[sorted.length - 1] : null;
  return {
    consensus_line: median(points),
    points_min,
    points_max,
    points_q1: q1,
    points_q3: q3,
    points_iqr: q1 != null && q3 != null ? Number((q3 - q1).toFixed(1)) : null,
    points_range: points_min != null && points_max != null ? Number((points_max - points_min).toFixed(1)) : null,
  };
}

module.exports = { mean, median, quantile, stdevSample, percentileOfValue, buildHistogram, summarize, computeMarketDispersion };
