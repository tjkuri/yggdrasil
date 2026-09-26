module.exports = {
  MIN_ATTEMPTS_DEF_ROW:  10,    // ignore garbage-time QB rows when building defense ratings
  RECENCY_WEIGHT_CURRENT: 2.0,  // weight given to current-season defensive games
  RECENCY_WEIGHT_PRIOR:   1.0,  // weight given to prior-season defensive games

  // Shrinkage: factor = (weighted_n * raw + K) / (weighted_n + K) — pulls toward 1.0 (league avg)
  // when a defense's sample is thin. K is in "pseudo-games."
  SHRINK_K_PASS: 8,   // pass YPA allowed vs resulting QB yards: strong, well-established signal (corr ~0.68 w/ raw yards allowed)
  SHRINK_K_RUSH: 12,  // rush-stop vs pass attempts faced ("funnel" effect): real but weaker (corr ~0.30 in 2025 data) — shrink harder

  VOLUME_DAMPEN_EXP: 0.35, // exponent applied to rush_stop_factor before treating it as an attempts multiplier

  // Verdict — edge is model probability vs. the market's DE-VIGGED fair probability (proportional
  // method, standard in sports betting), not a raw z-score comparison. Confidence comes from a
  // Wilson score interval on the model's own probability, not z-score magnitude — see
  // utils/nflMath.js computeQbVerdict for why (short version: z-score alone doesn't widen for
  // small samples the way a proper interval does).
  WILSON_Z:          1.645, // ~95% one-sided confidence bound on the model's own p_over/p_under
  CONFIDENCE_MARGIN: 0.05,  // Wilson lower bound must clear fair_prob by this much for HIGH (vs just MEDIUM)
};
