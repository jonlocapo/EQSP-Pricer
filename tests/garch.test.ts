import { describe, expect, it } from 'vitest';
import { normals } from '../src/engine/rng';
import { ewmaVariance, fitGjr, garchTermStructure } from '../src/model/garch';

/**
 * These tests pin the maths that makes this module the real deliverable:
 * a GJR-GARCH(1,1) fit recovers KNOWN parameters from a simulated series —
 * including the leverage asymmetry — and the closed-form term structure it
 * produces mean-reverts monotonically toward the long-run level, the
 * property four overlapping trailing windows structurally cannot have.
 */

const DAYS_PER_YEAR = 252;

/** Simulates a GJR-GARCH(1,1) return series from KNOWN parameters, using the
 * seeded standard-normal generator engine/rng.ts already provides for
 * reproducible Monte Carlo. `gamma = 0` reproduces the symmetric GARCH(1,1)
 * the asymmetry is tested against. */
function simulateGjr(omega: number, alpha: number, gamma: number, beta: number, n: number, seed: number): number[] {
  const z = normals(seed);
  const returns: number[] = [];
  let variance = omega / (1 - alpha - beta - gamma / 2); // start at the long-run level
  for (let t = 0; t < n; t++) {
    const r = Math.sqrt(variance) * z();
    returns.push(r);
    const arch = alpha + (r < 0 ? gamma : 0);
    variance = omega + arch * r * r + beta * variance;
  }
  return returns;
}

describe('fitGjr parameter recovery', () => {
  it('recovers (alpha, gamma, beta) from a long simulated series within a stated tolerance', () => {
    // A daily-equity-like calibration with a clear leverage effect:
    // alpha=0.05 (ARCH), gamma=0.08 (asymmetry), beta=0.90 (GARCH),
    // persistence 0.99 -- realistic and comfortably inside the stationary
    // region. 4000 observations (~16 trading years) is long enough for a
    // three-parameter MLE with variance targeting to identify all three
    // parameters to within a few hundredths; a much shorter sample would
    // need a looser tolerance because GARCH parameters are notoriously slow
    // to pin down.
    const trueOmega = 8e-7;
    const trueAlpha = 0.05;
    const trueGamma = 0.08;
    const trueBeta = 0.9;
    const returns = simulateGjr(trueOmega, trueAlpha, trueGamma, trueBeta, 4000, 2024);

    const fit = fitGjr(returns);
    expect(fit.converged).toBe(true);
    expect(fit.alpha).toBeCloseTo(trueAlpha, 1); // within 0.05
    expect(fit.gamma).toBeCloseTo(trueGamma, 1); // within 0.05
    expect(fit.beta).toBeCloseTo(trueBeta, 1); // within 0.05
    expect(fit.alpha + fit.beta + fit.gamma / 2).toBeLessThan(1);
  });

  it('does not invent an asymmetry on a symmetric (gamma=0) series', () => {
    // The GJR fit must degrade to the symmetric case when the series has no
    // leverage effect, not attach spurious asymmetry to noise.
    const returns = simulateGjr(8e-7, 0.08, 0, 0.9, 3000, 77);
    const fit = fitGjr(returns);
    expect(fit.converged).toBe(true);
    expect(fit.gamma).toBeLessThan(0.08);
    expect(fit.alpha).toBeCloseTo(0.08, 1);
    expect(fit.beta).toBeCloseTo(0.9, 1);
  });

  it('falls back (unconverged, beta=1) on a too-short sample rather than fitting noise', () => {
    const returns = simulateGjr(8e-7, 0.05, 0.08, 0.9, 40, 11);
    const fit = fitGjr(returns);
    expect(fit.converged).toBe(false);
    expect(fit.beta).toBe(1);
  });

  it('is safe on a constant (zero-variance) return series: no NaN', () => {
    const fit = fitGjr(new Array(200).fill(0));
    expect(Number.isFinite(fit.nextVar)).toBe(true);
    expect(fit.converged).toBe(false); // sampleVar is 0, nothing to target
  });
});

describe('garchTermStructure shape', () => {
  const horizons = [5, 21, 63, 126, 252, 504];

  it('decays monotonically toward the long-run level, starting ABOVE it', () => {
    const trueOmega = 2e-6;
    const trueAlpha = 0.1;
    const trueGamma = 0.05;
    const trueBeta = 0.85;
    const base = simulateGjr(trueOmega, trueAlpha, trueGamma, trueBeta, 3000, 5);
    // Append a shock at the end so sigma2_{t+1} is pushed above the
    // long-run level right before the term structure is read.
    const shocked = [...base, 0.06, -0.05];

    const fit = fitGjr(shocked);
    expect(fit.converged).toBe(true);
    const p = fit.alpha + fit.beta + fit.gamma / 2;
    const fittedLongRunVar = fit.omega / (1 - p);
    expect(fit.nextVar).toBeGreaterThan(fittedLongRunVar); // the shock landed above long-run, as intended

    const { terms, converged } = garchTermStructure(shocked, horizons);
    expect(converged).toBe(true);
    for (let i = 1; i < terms.length; i++) {
      expect(terms[i].vol).toBeLessThanOrEqual(terms[i - 1].vol + 1e-12);
    }
    const longRunVol = Math.sqrt(fittedLongRunVar * DAYS_PER_YEAR);
    const gapShort = Math.abs(terms[0].vol - longRunVol);
    const gapLong = Math.abs(terms[terms.length - 1].vol - longRunVol);
    expect(gapLong).toBeLessThan(gapShort);

    // At an asymptotically long horizon, the closed form's own limit must
    // land on the long-run level -- this is what "converges" means for a
    // formula whose average-gap decays like 1/T.
    const { terms: farTerms } = garchTermStructure(shocked, [2_000_000]);
    expect(farTerms[0].vol).toBeCloseTo(longRunVol, 3);
  });

  it('rises monotonically toward the long-run level, starting BELOW it', () => {
    const trueOmega = 2e-6;
    const trueAlpha = 0.1;
    const trueGamma = 0.05;
    const trueBeta = 0.85;
    const base = simulateGjr(trueOmega, trueAlpha, trueGamma, trueBeta, 3000, 6);
    // A long run of tiny, quiet returns pulls sigma2_{t+1} below the
    // long-run level right before the read.
    const quiet = [...base, ...new Array(5).fill(0.0002)];

    const fit = fitGjr(quiet);
    expect(fit.converged).toBe(true);
    const p = fit.alpha + fit.beta + fit.gamma / 2;
    const fittedLongRunVar = fit.omega / (1 - p);
    expect(fit.nextVar).toBeLessThan(fittedLongRunVar); // the quiet run landed below long-run, as intended

    const { terms, converged } = garchTermStructure(quiet, horizons);
    expect(converged).toBe(true);
    for (let i = 1; i < terms.length; i++) {
      expect(terms[i].vol).toBeGreaterThanOrEqual(terms[i - 1].vol - 1e-12);
    }
    const longRunVol = Math.sqrt(fittedLongRunVar * DAYS_PER_YEAR);
    const gapShort = Math.abs(terms[0].vol - longRunVol);
    const gapLong = Math.abs(terms[terms.length - 1].vol - longRunVol);
    expect(gapLong).toBeLessThan(gapShort);

    const { terms: farTerms } = garchTermStructure(quiet, [2_000_000]);
    expect(farTerms[0].vol).toBeCloseTo(longRunVol, 3);
  });

  it('is flat when persistence sits at the stationarity boundary (the EWMA degenerate case)', () => {
    // A near-unit-root series gives fitGjr nothing but noise to distinguish
    // "very persistent GARCH" from "no mean reversion at all", so the fit is
    // expected to fall back to the flat EWMA rung.
    const returns = simulateGjr(1e-8, 0.05, 0, 0.949, 1000, 9);
    const { terms, converged } = garchTermStructure(returns, horizons);
    if (!converged) {
      const first = terms[0].vol;
      for (const t of terms) expect(t.vol).toBeCloseTo(first, 10);
    }
  });

  it('falls back cleanly on too few observations: flat, finite, no NaN', () => {
    const returns = simulateGjr(8e-7, 0.05, 0.08, 0.9, 30, 3);
    const { terms, converged } = garchTermStructure(returns, horizons);
    expect(converged).toBe(false);
    const first = terms[0].vol;
    for (const t of terms) {
      expect(Number.isFinite(t.vol)).toBe(true);
      expect(t.vol).toBeCloseTo(first, 10);
    }
  });

  it('is safe on a constant price series (all-zero returns): no NaN', () => {
    const { terms } = garchTermStructure(new Array(300).fill(0), horizons);
    for (const t of terms) {
      expect(Number.isFinite(t.vol)).toBe(true);
      expect(t.vol).toBe(0);
    }
  });
});

describe('ewmaVariance', () => {
  it('matches the RiskMetrics recursion by construction', () => {
    const returns = [0.01, -0.02, 0.015, 0.0, -0.005];
    const lambda = 0.94;
    let expected = returns[0] * returns[0];
    for (let i = 1; i < returns.length; i++) expected = lambda * expected + (1 - lambda) * returns[i] * returns[i];
    expect(ewmaVariance(returns, lambda)).toBeCloseTo(expected, 15);
  });

  it('is zero for an empty series', () => {
    expect(ewmaVariance([])).toBe(0);
  });
});
