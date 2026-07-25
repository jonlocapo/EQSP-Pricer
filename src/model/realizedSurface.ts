/**
 * A volatility surface derived from REALIZED price history, for underlyings
 * whose option chains cannot be fetched.
 *
 * WHY: free option chains are unreliable in a pure browser app — Yahoo's
 * options endpoint generally needs session cookies, CBOE is US-only and
 * CORS-blocked, and public proxies come and go. Daily closes, by contrast,
 * fetch dependably (they are the same endpoint the spot fetch already uses).
 * So rather than fall back to a single flat number, the app computes what the
 * history can actually support: a volatility TERM STRUCTURE and a SKEW.
 *
 * HOW the skew is obtained: the Gram-Charlier expansion of Backus, Foresi and
 * Wu ("Accounting for Biases in Black-Scholes") relates an option's
 * Black-Scholes implied vol to the higher moments of the return distribution:
 *
 *     sigma(d) ~= sigma * [ 1 - (skew/6)*d - (exKurt/24)*(1 - d^2) ]
 *
 * with d the standardized log-moneyness. Negative return skewness — the normal
 * equity case — therefore raises the vol at low strikes, which is the skew this
 * surface needs to reproduce. The moments are measured, not assumed.
 *
 * WHAT THIS IS NOT: implied volatility. It is a realized-moment estimate, and
 * it carries no volatility risk premium, so it usually sits BELOW traded
 * implied levels. Label it as realized wherever it reaches the user, and prefer
 * a real chain whenever one is available.
 */
import type { VolSurface } from './volSurface';

/** Trading days per year, matching the engine's simulation frequency. */
const DAYS_PER_YEAR = 252;

/** Keep a synthetic vol inside a sane band, both relative to its own ATM level
 * and absolutely, so a fat-tailed sample cannot produce a nonsense wing. */
const MIN_REL = 0.4;
const MAX_REL = 2.5;
const MIN_ABS = 0.01;
const MAX_ABS = 2.0;

/** Strikes, as % of spot, the surface is tabulated at. Wide enough to cover the
 * barriers these products use without extrapolating. */
const DEFAULT_STRIKE_PCTS = [50, 60, 70, 80, 90, 95, 100, 105, 110, 120, 140];

export interface RealizedMoments {
  /** Realized vol per horizon, ascending by tYears. At least one entry. */
  terms: { tYears: number; vol: number }[];
  /** Skewness of DAILY log returns (negative for typical equities). */
  skewDaily: number;
  /** EXCESS kurtosis of DAILY log returns (0 = Gaussian). */
  excessKurtDaily: number;
}

/** Sample vol, skewness and excess kurtosis of a daily log-return series. */
export function dailyReturnMoments(logReturns: number[]): {
  volDaily: number;
  skewDaily: number;
  excessKurtDaily: number;
} {
  const n = logReturns.length;
  if (n < 3) return { volDaily: 0, skewDaily: 0, excessKurtDaily: 0 };
  const mean = logReturns.reduce((a, b) => a + b, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const r of logReturns) {
    const d = r - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const sd = Math.sqrt(m2);
  if (!(sd > 0)) return { volDaily: 0, skewDaily: 0, excessKurtDaily: 0 };
  return {
    volDaily: sd,
    skewDaily: m3 / (sd * sd * sd),
    excessKurtDaily: m4 / (m2 * m2) - 3,
  };
}

/**
 * Realized vol over several trailing windows, giving a term structure instead
 * of one number. Windows longer than the available history are skipped.
 */
export function realizedTermStructure(
  logReturns: number[],
  windowsDays: number[] = [21, 63, 126, 252],
): { tYears: number; vol: number }[] {
  const terms: { tYears: number; vol: number }[] = [];
  for (const w of windowsDays) {
    if (logReturns.length < Math.max(20, Math.floor(w * 0.6))) continue;
    const slice = logReturns.slice(-w);
    const { volDaily } = dailyReturnMoments(slice);
    if (volDaily > 0) terms.push({ tYears: w / DAYS_PER_YEAR, vol: volDaily * Math.sqrt(DAYS_PER_YEAR) });
  }
  return terms;
}

function clampVol(v: number, atm: number): number {
  return Math.min(MAX_ABS, Math.max(MIN_ABS, Math.min(atm * MAX_REL, Math.max(atm * MIN_REL, v))));
}

/**
 * Builds a surface from realized moments. Each term's smile comes from the
 * Gram-Charlier relation above, renormalized so the ATM vol equals the measured
 * realized vol exactly (the raw expansion shifts the level by the kurtosis
 * term, which would otherwise make the headline number unrecognizable).
 *
 * Daily moments are aggregated to each horizon the standard way: over n
 * independent days skewness scales as 1/sqrt(n) and excess kurtosis as 1/n, so
 * the smile flattens with maturity — which is also what real surfaces do.
 */
export function buildRealizedSurface(
  spot: number,
  moments: RealizedMoments,
  source: string,
  strikePcts: number[] = DEFAULT_STRIKE_PCTS,
): VolSurface {
  if (!(spot > 0)) throw new Error('Cannot build a realized surface without a positive spot');
  if (moments.terms.length === 0) throw new Error('Not enough price history for a realized vol surface');

  const slices = moments.terms.map(({ tYears, vol }) => {
    const n = Math.max(1, tYears * DAYS_PER_YEAR);
    const skewT = moments.skewDaily / Math.sqrt(n);
    const exKurtT = moments.excessKurtDaily / n;
    const sqrtT = Math.sqrt(tYears);

    // Level factor at d = 0, used to re-anchor the smile to the measured ATM.
    const atmFactor = 1 - exKurtT / 24;

    const points = strikePcts.map((pct) => {
      const strike = (pct / 100) * spot;
      // Standardized log-moneyness. Positive below spot, which is the side the
      // negative-skew term must lift.
      const d = Math.log(spot / strike) / (vol * sqrtT);
      const factor = 1 - (skewT / 6) * d - (exKurtT / 24) * (1 - d * d);
      const iv = atmFactor > 0 ? vol * (factor / atmFactor) : vol;
      return { strike, iv: clampVol(iv, vol) };
    });

    return { tYears, points };
  });

  return { spotRef: spot, slices, source };
}
