module.exports = {
  SAMPLE_SIZE:          10,     // games per team to pull
  LAMBDA:               0.96,   // exponential decay base per day (0.96^7 ≈ 0.75)
  HOME_BOOST:           1.5,    // fallback home court adjustment in points
  MIN_HOME_AWAY_GAMES:  4,      // min games per split to use venue-specific stats

  Z_HIGH:               1.5,    // |z| >= this → HIGH confidence
  Z_MEDIUM:             0.8,    // |z| >= this → MEDIUM confidence
  MIN_Z_THRESHOLD:      0.5,    // |z| < this → NO_BET regardless of EV

  VIG_WIN:              0.9091, // profit per $1 risked at -110 (100/110)
  VIG_RISK:             1.0,    // amount lost per $1 risked on a loss
};
