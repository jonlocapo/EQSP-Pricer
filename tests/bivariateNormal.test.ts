import { describe, expect, it } from 'vitest';
import { bsCall, normCdf } from '../src/engine/blackScholes';
import { normals } from '../src/engine/rng';
import { gaussLegendre, normCdf2, quadratureCallOnMin, stulzCallOnMin, worstOfDigitalProb } from './bivariateNormal';

/**
 * Group A of the worst-of prerequisites: reference maths with a KNOWN right
 * answer, written and passing before any basket code exists.
 *
 *  - A1: the bivariate normal CDF itself, checked at its two analytically
 *    known points (rho=0 factorizes, rho=1 collapses to the smaller marginal)
 *    and at the closed form Phi_2(0,0;rho) = 1/4 + asin(rho)/(2 pi).
 *  - A2: the two-asset worst-of digital, which is exactly a bivariate-normal
 *    tail, compared against a Monte Carlo that uses the engine's real RNG and
 *    a test-local Cholesky â€” the cheapest possible check that the correlation
 *    handling is right before any payoff code exists.
 *  - A3: Stulz's closed form for a call on the minimum, cross-checked against
 *    an independent 2D quadrature of the exact expectation (shares no
 *    derivation with Stulz), so either side's mistake would be caught.
 */

describe('A1: bivariate normal CDF', () => {
  it('factorizes at rho = 0: Phi_2(a,b;0) = Phi(a)Phi(b)', () => {
    for (const [a, b] of [[0, 0], [0.8, -0.5], [1.2, 2.1], [-1.7, 0.3], [-2, -2]]) {
      expect(normCdf2(a, b, 0)).toBeCloseTo(normCdf(a) * normCdf(b), 9);
    }
  });

  it('collapses to the smaller marginal at rho = 1: Phi_2(a,b;1) = min(Phi(a), Phi(b))', () => {
    expect(normCdf2(0.5, 0.5, 1)).toBeCloseTo(normCdf(0.5), 12);
    expect(normCdf2(0.5, 1.0, 1)).toBeCloseTo(normCdf(0.5), 12);
    expect(normCdf2(1.0, 0.5, 1)).toBeCloseTo(normCdf(0.5), 12);
    expect(normCdf2(-0.5, 1.5, 1)).toBeCloseTo(normCdf(-0.5), 12);
  });

  it('matches the closed form at the origin: Phi_2(0,0;rho) = 1/4 + asin(rho)/(2 pi)', () => {
    for (const rho of [-0.9, -0.5, -0.2, 0, 0.2, 0.5, 0.9]) {
      expect(normCdf2(0, 0, rho)).toBeCloseTo(0.25 + Math.asin(rho) / (2 * Math.PI), 9);
    }
  });

  it('is a proper CDF: bounded, monotone in each argument and in rho', () => {
    expect(normCdf2(3, 3, 0.99)).toBeLessThan(1);
    expect(normCdf2(0.5, 0.5, 0.4)).toBeGreaterThan(normCdf2(0.5, 0.5, -0.4));
    expect(normCdf2(0.5, 0.5, 0.4)).toBeGreaterThan(normCdf2(0.2, 0.5, 0.4));
  });

  it('the Gauss-Legendre helper is self-consistent', () => {
    const { x, w } = gaussLegendre(80);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(2, 12);
    // Legendre nodes are symmetric.
    for (let i = 0; i < 40; i++) expect(x[i]).toBeCloseTo(-x[79 - i], 12);
  });

  it('handles the infinities and the near-perfect-correlation boundary', () => {
    expect(normCdf2(Infinity, 0.5, 0.3)).toBeCloseTo(normCdf(0.5), 12);
    expect(normCdf2(-Infinity, 0.5, 0.3)).toBe(0);
    expect(normCdf2(0.7, 0.7, 0.999999999)).toBeCloseTo(normCdf(0.7), 6);
    expect(normCdf2(0.7, 0.7, -0.999999999)).toBeCloseTo(Math.max(0, 2 * normCdf(0.7) - 1), 6);
  });
});

describe('A2: two-asset worst-of digital', () => {
  /**
   * Monte Carlo of P(min(S1,S2) > K) using the ENGINE's seeded Box-Muller
   * generator and a test-local Cholesky of the two-asset correlation â€” the
   * part the basket work is most likely to get wrong, checked in isolation.
   */
  function mcWorstOfDigital(
    s1: number, s2: number, sigma1: number, sigma2: number, rho: number,
    r: number, q1: number, q2: number, k: number, t: number,
    numPaths: number, seed: number,
  ): { p: number; se: number } {
    const z = normals(seed);
    const sqrtT = Math.sqrt(t);
    const nu1 = (r - q1 - 0.5 * sigma1 * sigma1) * t;
    const nu2 = (r - q2 - 0.5 * sigma2 * sigma2) * t;
    const c = Math.sqrt(1 - rho * rho);
    let hits = 0;
    for (let n = 0; n < numPaths; n++) {
      const z1 = z();
      const z2 = rho * z1 + c * z();
      const s1t = s1 * Math.exp(nu1 + sigma1 * sqrtT * z1);
      const s2t = s2 * Math.exp(nu2 + sigma2 * sqrtT * z2);
      if (Math.min(s1t, s2t) > k) hits += 1;
    }
    const p = hits / numPaths;
    return { p, se: Math.sqrt((p * (1 - p)) / numPaths) };
  }

  it('matches the closed form for every tested correlation, within MC noise', () => {
    // A worst-of barrier at 80% on two 20%-vol names over a year. The closed
    // form is exact; the Monte Carlo is checked against it at +/-3 standard
    // errors of the binomial estimator.
    const s1 = 100, s2 = 100, sigma1 = 0.2, sigma2 = 0.2;
    const r = 0.03, q1 = 0.02, q2 = 0.01, k = 80, t = 1;
    const numPaths = 200_000;
    for (const rho of [-0.9, -0.5, 0, 0.5, 0.9]) {
      const expected = worstOfDigitalProb(s1, s2, sigma1, sigma2, rho, r, q1, q2, k, t);
      const { p, se } = mcWorstOfDigital(s1, s2, sigma1, sigma2, rho, r, q1, q2, k, t, numPaths, 12345 + Math.round(rho * 100));
      expect(Math.abs(p - expected)).toBeLessThan(3 * se + 1e-12);
    }
  });

  it('monotone in correlation: a higher correlation raises P(both survive)', () => {
    // With equal vols, the worst-of digital's probability rises with rho: the
    // two assets move together, so the chance BOTH stay above the barrier is
    // larger. This is the correlation sensitivity that makes the feature live.
    const prev = worstOfDigitalProb(100, 100, 0.2, 0.2, -0.9, 0.03, 0.02, 0.01, 80, 1);
    const next = worstOfDigitalProb(100, 100, 0.2, 0.2, 0.9, 0.03, 0.02, 0.01, 80, 1);
    expect(next).toBeGreaterThan(prev);
  });
});

describe('A3: Stulz call on the minimum of two assets', () => {
  it('agrees with the independent conditional-expectation reference across parameter sets', () => {
    // Two independent derivations of the same expectation: Stulz via change of
    // numeraire, the reference by conditioning on one asset and integrating the
    // other's truncated-lognormal expectation in closed form. They share no
    // formula, so an argument slip on either side shows up here.
    const cases: [number, number, number, number, number, number, number, number, number][] = [
      // s1, s2, sigma1, sigma2, rho, r, q1, q2, k
      [100, 100, 0.2, 0.2, 0.5, 0.03, 0.02, 0.01, 95],
      [100, 100, 0.2, 0.2, -0.5, 0.03, 0.02, 0.01, 95],
      [100, 100, 0.2, 0.2, 0.5, 0.03, 0.02, 0.01, 100],
      [110, 90, 0.3, 0.18, 0.3, 0.02, 0.01, 0.03, 90],
      [100, 100, 0.2, 0.35, 0.8, 0.03, 0.02, 0.01, 85],
      [100, 100, 0.2, 0.2, -0.9, 0.05, 0, 0.02, 100],
    ];
    for (const [s1, s2, sigma1, sigma2, rho, r, q1, q2, k] of cases) {
      const stulz = stulzCallOnMin(s1, s2, sigma1, sigma2, rho, r, q1, q2, k, 1);
      const ref = quadratureCallOnMin(s1, s2, sigma1, sigma2, rho, r, q1, q2, k, 1);
      // The quadrature converges only polynomially where min(S1,S2) has its
      // kink (a diagonal line in the standardized space), so the two witnesses
      // agree to ~1e-4, not machine precision. 5e-4 still catches any real
      // mistake in either derivation, which would be off by O(0.1) or more —
      // and the rho=1-identical and K=0 cases below pin the structure to
      // 1e-9 / 1e-5 where convergence is fast.
      expect(Math.abs(stulz - ref)).toBeLessThan(5e-4 * Math.max(1, stulz));
    }
  });

  it('at rho = 1 with identical assets, equals the single-asset Black-Scholes call', () => {
    // At rho = 1 AND identical inputs, both assets are the same random
    // variable, so min(S1, S2) = S1 and the Stulz value must equal the
    // single-asset call exactly. The "identical inputs" half is what makes
    // this closed-form-grade: at rho = 1 with different vols the assets share
    // a driver but scale differently and the minimum keeps swapping, so only
    // the identical-inputs case has a closed form to hit.
    const s = 100, sigma = 0.2, r = 0.03, q = 0.02, k = 95, t = 1;
    const stulz = stulzCallOnMin(s, s, sigma, sigma, 1, r, q, q, k, t);
    const bs = bsCall(s, k, t, sigma, r, q);
    expect(stulz).toBeCloseTo(bs, 9);
  });

  it('recovers the deep-in-the-money limit: C -> e^{-rT} E[min(S1,S2)] as K -> 0', () => {
    // At K = 0 the option is exercised for sure, so the value must be the
    // discounted expectation of the minimum. The Stulz formula and the
    // conditional reference must agree here too, and both must be finite (a
    // previous implementation overflowed on extreme thresholds).
    const v = stulzCallOnMin(100, 100, 0.2, 0.2, 0.5, 0.03, 0.02, 0.01, 0, 1);
    const ref = quadratureCallOnMin(100, 100, 0.2, 0.2, 0.5, 0.03, 0.02, 0.01, 0, 1);
    expect(v).toBeGreaterThan(80);
    expect(Math.abs(v - ref)).toBeLessThan(1e-5);
  });

  it('is positive and bounded for a mid-market case', () => {
    const v = stulzCallOnMin(100, 100, 0.2, 0.2, 0.5, 0.03, 0.02, 0.01, 95, 1);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(100);
  });
});
