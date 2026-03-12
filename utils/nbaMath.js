/**
 * Exponential recency-weighted mean.
 * @param {Array<{date: string, value: number}>} items - sorted newest-first
 * @param {string} today   - 'YYYY-MM-DD' reference date
 * @param {number} lambda  - decay base per day (e.g. 0.96)
 * @returns {number|null}
 */
function weightedMean(items, today, lambda) {
  if (!items || items.length === 0) return null;
  const todayMs = new Date(today).getTime();
  let weightedSum = 0, weightSum = 0;
  for (const item of items) {
    const daysSince = (todayMs - new Date(item.date).getTime()) / 86400000;
    const w = Math.pow(lambda, daysSince);
    weightedSum += item.value * w;
    weightSum += w;
  }
  return weightSum > 0 ? weightedSum / weightSum : null;
}

/**
 * Exponential recency-weighted population variance.
 * @param {Array<{date: string, value: number}>} items
 * @param {string} today
 * @param {number} lambda
 * @param {number} wMean  - pre-computed weightedMean (avoids double work)
 * @returns {number|null}
 */
function weightedVariance(items, today, lambda, wMean) {
  if (!items || items.length < 2 || wMean == null) return null;
  const todayMs = new Date(today).getTime();
  let weightedSumSq = 0, weightSum = 0;
  for (const item of items) {
    const daysSince = (todayMs - new Date(item.date).getTime()) / 86400000;
    const w = Math.pow(lambda, daysSince);
    weightedSumSq += w * Math.pow(item.value - wMean, 2);
    weightSum += w;
  }
  return weightSum > 0 ? weightedSumSq / weightSum : null;
}

/**
 * Normal CDF via Abramowitz & Stegun rational approximation.
 * Accurate to ~1.5e-7 for all z.
 * normalCDF(0) → 0.5, normalCDF(1.96) → ~0.975
 * @param {number} z
 * @returns {number} probability in [0, 1]
 */
function normalCDF(z) {
  const sign = z < 0 ? -1 : 1;
  const absZ = Math.abs(z);
  const t = 1.0 / (1.0 + 0.2316419 * absZ);
  const poly = t * (0.319381530
    + t * (-0.356563782
    + t * (1.781477937
    + t * (-1.821255978
    + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * absZ * absZ) / Math.sqrt(2 * Math.PI);
  const cdf = 1.0 - pdf * poly;
  return 0.5 * (1.0 + sign * (2 * cdf - 1));
}

module.exports = { weightedMean, weightedVariance, normalCDF };
