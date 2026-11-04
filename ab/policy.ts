// The numbers of the A/B policy, in one place. TEST_STRATEGY.md section 12 states the policy in words; these are its numbers, each with the
// reason it is what it is. A pre-registration (ab/prereg.ts) may choose its own sample size, thresholds and seed, but not weaken these.

export const AB_POLICY = {
  /** The significance level of every test, and the share of splits an A/A calibration may declare significant (TEST_STRATEGY.md section 12). */
  alpha: 0.05,
  /** Coverage of every confidence interval: 1 - alpha, so that "the interval excludes zero" and "p < alpha" are the same kind of statement. */
  confidenceLevel: 0.95,
  /** "Never fewer than thirty" sessions per arm for an experiment (TEST_STRATEGY.md section 12). A pipeline check may use fewer and then decides nothing. */
  minSessionsPerArm: 30,
  /** Bootstrap resamples behind an interval; the brief's default. An experiment may not use fewer than `minBootstrapResamples`. */
  bootstrapResamples: 5000,
  minBootstrapResamples: 1000,
  /** Random splits of an A/A pool in the calibration (PB-AB-001). */
  calibrationSplits: 2000,
  /** The power at which the minimum detectable effect is defined. */
  targetPower: 0.8,
  /** Warm-up sessions per arm: recorded and discarded. More than this is a sign the warm-up is hiding something. */
  maxWarmupPerArm: 5,
  /** Share of failed sessions in an arm above which neither "ship B" nor "no difference" can be said (defaults of a pre-registration). */
  defaultMaxFailedShare: 0.1,
} as const;
