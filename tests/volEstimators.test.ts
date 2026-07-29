import { describe, expect, it } from 'vitest';
import { normals } from '../src/engine/rng';
import {
  closeToCloseVar,
  garmanKlassVar,
  parkinsonVar,
  rogersSatchellVar,
  yangZhangVar,
  type Bar,
} from '../src/model/volEstimators';

/**
 * These tests justify the whole module: they show the range-based
 * estimators recover a KNOWN volatility from synthetic OHLC data, and that
 * Yang-Zhang does so with visibly LESS sampling error than close-to-close
 * over the same days — the efficiency gain that motivates replacing
 * close-to-close as the default. A second block shows Rogers-Satchell stays
 * put under a strong drift while the estimators that ignore drift move.
 */

const DAYS_PER_YEAR = 252;

/**
 * Synthetic daily OHLC bars from a seeded GBM, subsampled intraday so the
 * high and low are genuine path extrema, not just max(open, close). `sigma`
 * and `driftAnnual` are annualized; the daily variance realized in the bars
 * converges to `sigma^2` as the sample grows.
 */
function syntheticBars(sigma: number, days: number, seed: number, driftAnnual = 0, subSteps = 24): Bar[] {
  const z = normals(seed);
  const dt = 1 / DAYS_PER_YEAR / subSteps;
  let price = 100;
  const bars: Bar[] = [];
  for (let d = 0; d < days; d++) {
    const open = price;
    let high = price;
    let low = price;
    for (let s = 0; s < subSteps; s++) {
      price = price * Math.exp((driftAnnual - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z());
      if (price > high) high = price;
      if (price < low) low = price;
    }
    const close = price;
    bars.push({ open, high: Math.max(high, open, close), low: Math.min(low, open, close), close });
  }
  return bars;
}

function annualizedVol(dailyVar: number): number {
  return Math.sqrt(dailyVar * DAYS_PER_YEAR);
}

describe('range-based estimators recover a known volatility', () => {
  const sigma = 0.25;
  const bars = syntheticBars(sigma, 1500, 7);

  it('closeToCloseVar recovers sigma within its (wide) sampling error', () => {
    expect(annualizedVol(closeToCloseVar(bars))).toBeCloseTo(sigma, 1);
  });

  it('parkinsonVar recovers sigma', () => {
    expect(annualizedVol(parkinsonVar(bars))).toBeCloseTo(sigma, 1);
  });

  it('garmanKlassVar recovers sigma', () => {
    expect(annualizedVol(garmanKlassVar(bars))).toBeCloseTo(sigma, 1);
  });

  it('rogersSatchellVar recovers sigma', () => {
    expect(annualizedVol(rogersSatchellVar(bars))).toBeCloseTo(sigma, 1);
  });

  it('yangZhangVar recovers sigma', () => {
    expect(annualizedVol(yangZhangVar(bars))).toBeCloseTo(sigma, 1);
  });
});

describe('efficiency ordering: Yang-Zhang is less noisy than close-to-close', () => {
  it('has lower dispersion across repeated independent samples, for the same sample size', () => {
    const sigma = 0.3;
    const days = 250;
    const seeds = Array.from({ length: 24 }, (_, i) => 1000 + i * 97);

    const c2cEstimates = seeds.map((s) => annualizedVol(closeToCloseVar(syntheticBars(sigma, days, s))));
    const yzEstimates = seeds.map((s) => annualizedVol(yangZhangVar(syntheticBars(sigma, days, s))));

    const stdev = (xs: number[]): number => {
      const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
    };

    const c2cStd = stdev(c2cEstimates);
    const yzStd = stdev(yzEstimates);
    // Yang-Zhang combines several range-based components, so it is
    // materially more efficient than the single close-to-close return —
    // the literature reports a 5-14x variance-reduction ratio depending on
    // the overnight/intraday variance split; require only that the
    // direction and a real margin hold, so the test is not brittle to the
    // synthetic generator's exact microstructure.
    expect(yzStd).toBeLessThan(c2cStd * 0.7);
  });
});

describe('Rogers-Satchell is drift-independent; the naive range estimators are not', () => {
  it('barely moves under a strong deterministic drift, while Parkinson and Garman-Klass inflate', () => {
    const sigma = 0.15;
    const days = 6000;
    const seed = 42;
    // A strong, sustained annualized drift -- far beyond anything realistic
    // (550% per year), so the daily drift is comparable to the daily
    // diffusive move and the range-estimator bias is unmistakable against
    // sampling noise. A long sample (6000 days) keeps that noise down
    // further, since the bias itself is a second-order effect.
    const strongDrift = 5.5;

    const flatBars = syntheticBars(sigma, days, seed, 0);
    const driftBars = syntheticBars(sigma, days, seed, strongDrift);

    const rsFlat = annualizedVol(rogersSatchellVar(flatBars));
    const rsDrift = annualizedVol(rogersSatchellVar(driftBars));
    const pkFlat = annualizedVol(parkinsonVar(flatBars));
    const pkDrift = annualizedVol(parkinsonVar(driftBars));
    const gkFlat = annualizedVol(garmanKlassVar(flatBars));
    const gkDrift = annualizedVol(garmanKlassVar(driftBars));

    // Rogers-Satchell's relative change must be small...
    const rsRelChange = Math.abs(rsDrift - rsFlat) / rsFlat;
    // ...and much smaller than Parkinson's and Garman-Klass's, which have no
    // drift-cancelling term and so are pulled toward the drift's own scale.
    const pkRelChange = Math.abs(pkDrift - pkFlat) / pkFlat;
    const gkRelChange = Math.abs(gkDrift - gkFlat) / gkFlat;

    expect(rsRelChange).toBeLessThan(0.2);
    expect(pkRelChange).toBeGreaterThan(rsRelChange * 1.8);
    expect(gkRelChange).toBeGreaterThan(rsRelChange * 1.8);
  });
});

describe('guards', () => {
  const goodBar: Bar = { open: 100, high: 101, low: 99, close: 100.5 };

  it('throws a clear message on too few bars, rather than returning NaN', () => {
    expect(() => closeToCloseVar([goodBar])).toThrow(/need at least/i);
    expect(() => yangZhangVar([goodBar, goodBar])).toThrow(/need at least/i);
  });

  it('throws on a non-positive price instead of propagating NaN', () => {
    const badBar: Bar = { open: 0, high: 1, low: -1, close: 1 };
    expect(() => parkinsonVar([badBar])).toThrow(/positive/i);
    expect(() => rogersSatchellVar([badBar, goodBar])).toThrow(/positive/i);
  });

  it('is safe on a constant price series: zero variance, never NaN', () => {
    const flat: Bar[] = Array.from({ length: 10 }, () => ({ open: 100, high: 100, low: 100, close: 100 }));
    expect(closeToCloseVar(flat)).toBe(0);
    expect(parkinsonVar(flat)).toBe(0);
    expect(garmanKlassVar(flat)).toBe(0);
    expect(rogersSatchellVar(flat)).toBe(0);
    expect(yangZhangVar(flat)).toBe(0);
  });
});
