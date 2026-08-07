/**
 * Range-based daily variance estimators, computed from OHLC bars instead of
 * the close-only series the rest of the app used to be limited to.
 *
 * WHY: close-to-close vol uses ONE number per day (the close) and throws
 * away the high and the low, which the market also printed that day. The
 * high-low range carries real information about the day's variance, so an
 * estimator that uses it is more EFFICIENT — for the same number of days
 * observed, it has a smaller sampling error. That matters here because the
 * app only ever has a year or two of daily bars to work with, never a deep
 * intraday tape.
 *
 * Every function below returns a DAILY variance, not annualized and not a
 * volatility. The caller multiplies by 252 (trading days per year) and takes
 * a square root once it decides how to combine or use the number. Keeping
 * the scaling out of this module means one convention lives in one place.
 *
 * Convention: every estimator here is the classical "simple average of a
 * per-day term" (Parkinson 1980, Garman and Klass 1980, Rogers and Satchell
 * 1991), NOT a demeaned sample variance. This matters for
 * `closeToCloseVar`: it does NOT subtract the sample mean return, so a real
 * price drift biases it upward by roughly (drift * dt)^2 per day. That bias
 * is the classical motivation for Rogers-Satchell, which cancels the drift
 * term by construction (see its own comment below).
 *
 * A degenerate or too-small input throws a clear Error rather than
 * returning NaN, so a caller cannot accidentally propagate a silent
 * not-a-number into a vol surface. Every result is also clamped to be
 * non-negative: the range-based formulas are unbiased in EXPECTATION but a
 * single small sample can realize a negative sum, which sqrt would turn
 * into NaN downstream.
 */

/** One trading day's open, high, low and close. All four fields must be
 * strictly positive — a zero or negative print cannot come from a real
 * market and would make every log() below non-finite. */
export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

function assertUsableBars(bars: Bar[], minBars: number, name: string): void {
  if (bars.length < minBars) {
    throw new Error(`${name}: need at least ${minBars} bars, got ${bars.length}`);
  }
  for (const b of bars) {
    if (!(b.open > 0) || !(b.high > 0) || !(b.low > 0) || !(b.close > 0)) {
      throw new Error(`${name}: every bar needs a strictly positive open, high, low and close`);
    }
  }
}

function finiteOrThrow(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name}: computed a non-finite result`);
  return Math.max(0, value);
}

/**
 * Close-to-close daily variance: the mean squared daily log return,
 * `mean(ln(C_i / C_{i-1})^2)`. The simplest estimator, and the least
 * efficient — see the module comment for why, and for why it is NOT
 * demeaned.
 */
export function closeToCloseVar(bars: Bar[]): number {
  assertUsableBars(bars, 2, 'closeToCloseVar');
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const r = Math.log(bars[i].close / bars[i - 1].close);
    sum += r * r;
  }
  return finiteOrThrow(sum / (bars.length - 1), 'closeToCloseVar');
}

/**
 * Parkinson (1980) variance: `(1 / (4 ln 2)) * mean(ln(H/L)^2)`.
 *
 * Uses the day's full high-low range, which is a far more informative
 * statistic than the single close-to-close move for the same one day of
 * data. Two known weaknesses motivate the estimators below it in this file:
 * it is BLIND to overnight gaps (it only sees the range while trading was
 * live), and it is biased LOW in the presence of drift, because a trending
 * price tends to explore less of its potential range within one session
 * than a purely diffusive one would.
 */
export function parkinsonVar(bars: Bar[]): number {
  assertUsableBars(bars, 1, 'parkinsonVar');
  const n = bars.length;
  let sum = 0;
  for (const b of bars) {
    const hl = Math.log(b.high / b.low);
    sum += hl * hl;
  }
  return finiteOrThrow(sum / (4 * Math.LN2 * n), 'parkinsonVar');
}

/**
 * Garman and Klass (1980) variance:
 * `mean( 0.5 * ln(H/L)^2 - (2 ln 2 - 1) * ln(C/O)^2 )`.
 *
 * Adds the open-close move to Parkinson's high-low range, which raises
 * statistical efficiency further under their assumptions (no drift, no
 * overnight jump). Like Parkinson, it does not see the overnight gap and it
 * is still biased by a real drift, because both of its terms are simple
 * price ratios rather than the drift-cancelling ratios Rogers-Satchell
 * uses.
 */
export function garmanKlassVar(bars: Bar[]): number {
  assertUsableBars(bars, 1, 'garmanKlassVar');
  const n = bars.length;
  let sum = 0;
  for (const b of bars) {
    const hl = Math.log(b.high / b.low);
    const co = Math.log(b.close / b.open);
    sum += 0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co;
  }
  return finiteOrThrow(sum / n, 'garmanKlassVar');
}

/**
 * Rogers and Satchell (1991) variance:
 * `mean( ln(H/C)*ln(H/O) + ln(L/C)*ln(L/O) )`.
 *
 * Each term pairs the high and low against BOTH the open and the close, so
 * a constant drift over the day cancels out of the expectation to first
 * order — unlike Parkinson and Garman-Klass, whose range terms trend
 * upward with drift. This is the estimator to prefer whenever the
 * underlying is trending, which structured-product underlyings often are
 * over the trailing window a vol estimate is built from.
 */
export function rogersSatchellVar(bars: Bar[]): number {
  assertUsableBars(bars, 1, 'rogersSatchellVar');
  const n = bars.length;
  let sum = 0;
  for (const b of bars) {
    const hc = Math.log(b.high / b.close);
    const ho = Math.log(b.high / b.open);
    const lc = Math.log(b.low / b.close);
    const lo = Math.log(b.low / b.open);
    sum += hc * ho + lc * lo;
  }
  return finiteOrThrow(sum / n, 'rogersSatchellVar');
}

/**
 * Yang and Zhang (2000) variance — the DEFAULT estimator for this app.
 *
 * Splits each day into an overnight move (previous close to today's open)
 * and an intraday move (today's open to today's close), and combines their
 * sample variances with the drift-independent Rogers-Satchell estimator:
 *
 *   sigma_YZ^2 = sigma_overnight^2 + k * sigma_openToClose^2 + (1-k) * sigma_RS^2
 *
 * with the standard weight `k = 0.34 / (1.34 + (n+1)/(n-1))`, n the number
 * of overnight observations. Yang and Zhang derived k to MINIMIZE the
 * estimator's variance for a plausible range of the ratio between overnight
 * and intraday variance, which is why it is neither 0 nor 1 nor a simple
 * average.
 *
 * This is the only estimator here that sees the OVERNIGHT gap, which close
 * auctions and after-hours news make a real and often large share of an
 * equity's total variance, and it inherits Rogers-Satchell's drift
 * independence for the intraday piece. That combination — handles both
 * drift and gaps — is why it is the standard practitioner choice and the
 * default here.
 */
export function yangZhangVar(bars: Bar[]): number {
  // Needs at least 2 overnight observations for both sample variances below
  // to have a nonzero (n-1) denominator, so at least 3 bars.
  assertUsableBars(bars, 3, 'yangZhangVar');
  const n = bars.length - 1;

  const overnight: number[] = [];
  const openToClose: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    overnight.push(Math.log(bars[i].open / bars[i - 1].close));
    openToClose.push(Math.log(bars[i].close / bars[i].open));
  }

  const sampleVar = (xs: number[]): number => {
    const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
    const sumSq = xs.reduce((a, x) => a + (x - mean) * (x - mean), 0);
    return sumSq / (xs.length - 1);
  };

  const sigmaOvernight2 = sampleVar(overnight);
  const sigmaOpenClose2 = sampleVar(openToClose);
  // Rogers-Satchell over the same n days that have an overnight observation
  // (every bar except the very first, which has no prior close to gap from).
  const sigmaRs2 = rogersSatchellVar(bars.slice(1));

  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const variance = sigmaOvernight2 + k * sigmaOpenClose2 + (1 - k) * sigmaRs2;
  return finiteOrThrow(variance, 'yangZhangVar');
}
