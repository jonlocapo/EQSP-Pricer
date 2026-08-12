import { describe, expect, it } from 'vitest';
import { PathBatchGenerator } from '../src/engine/gbm';
import { choleskyLower } from '../src/model/correlation';
import type { MarketData } from '../src/model/market';
import { worstOfDigitalProb, stulzCallOnMin } from './bivariateNormal';

/**
 * The worst-of path generator, checked against the closed forms from Group A.
 *
 * Every other basket test is a COMPARISON: correlation 1 behaves like this,
 * higher correlation moves the price that way. None of those can catch a
 * sampler that is wrong by a steady factor, because a consistently wrong
 * answer still moves in the right direction. These check absolute values.
 */

const R = 0.03;
const T = 1;

/** A basket market. `spot` is a reference level only: every payoff here reads
 * relative performance, so a leg's starting level cancels. */
function basketMarket(
  vols: number[],
  divs: number[],
  correlation: number[][],
): MarketData {
  return {
    spot: 100,
    vol: vols[0],
    rate: R,
    divYield: divs[0],
    currency: 'EUR',
    basket: { assets: vols.map((v, i) => ({ vol: v, divYield: divs[i] })), correlation },
  };
}

/**
 * Simulates terminal worst-of performance and returns the sample mean of
 * `payoff(perf)` with its standard error. One step to maturity keeps the
 * comparison to the closed form exact in the time discretisation, so any gap
 * is the correlation handling and nothing else.
 */
function mcTerminal(
  market: MarketData,
  payoff: (perf: number) => number,
  paths = 400_000,
  nSteps = 1,
): { mean: number; stderr: number } {
  const gen = new PathBatchGenerator(20260807, nSteps, 100, market, T / nSteps);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let p = 0; p < paths / 2; p++) {
    const { plus, minus } = gen.nextPair();
    for (const path of [plus, minus]) {
      const v = payoff(path[nSteps] / path[0]);
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { mean, stderr: Math.sqrt(variance / n) };
}

describe('worst-of path generator against the closed forms', () => {
  it('matches the two-asset worst-of digital across correlations', () => {
    // The cleanest possible check: P(worst leg still above K) is a direct
    // bivariate normal probability, with no payoff machinery and no
    // discounting involved. It tests the joint law itself, which is what the
    // Cholesky is responsible for.
    const vols = [0.22, 0.31];
    const divs = [0.015, 0.028];
    const K = 0.85;
    for (const rho of [-0.5, 0, 0.4, 0.85]) {
      const market = basketMarket(vols, divs, [
        [1, rho],
        [rho, 1],
      ]);
      const { mean, stderr } = mcTerminal(market, (perf) => (perf > K ? 1 : 0));
      // Closed form on unit starting levels, which is what performance is.
      const exact = worstOfDigitalProb(1, 1, vols[0], vols[1], rho, R, divs[0], divs[1], K, T);
      expect(Math.abs(mean - exact)).toBeLessThan(4 * stderr + 1e-4);
    }
  });

  it('matches Stulz for a call on the minimum', () => {
    // A real payoff, discounted. Checks the drift and the Ito correction per
    // leg on top of the joint law.
    const vols = [0.2, 0.35];
    const divs = [0.01, 0.04];
    const rho = 0.3;
    const K = 0.95;
    const market = basketMarket(vols, divs, [
      [1, rho],
      [rho, 1],
    ]);
    const df = Math.exp(-R * T);
    const { mean, stderr } = mcTerminal(market, (perf) => df * Math.max(0, perf - K));
    const exact = stulzCallOnMin(1, 1, vols[0], vols[1], rho, R, divs[0], divs[1], K, T);
    expect(Math.abs(mean - exact)).toBeLessThan(4 * stderr + 1e-4);
  });

  it('collapses to the single-asset price at correlation 1 with identical legs', () => {
    // Correlation 1 alone is NOT enough: with different vols the legs are
    // driven by the same noise but scale differently, so they cross and the
    // minimum keeps swapping identity. Identical marginals are what make the
    // worst-of degenerate to one asset.
    const market = basketMarket([0.25, 0.25], [0.02, 0.02], [
      [1, 1],
      [1, 1],
    ]);
    const K = 0.9;
    const { mean, stderr } = mcTerminal(market, (perf) => (perf > K ? 1 : 0));
    // One asset: P(S_T/S_0 > K) under the risk-neutral measure.
    const nu = (R - 0.02 - 0.5 * 0.25 * 0.25) * T;
    const d = (Math.log(K) - nu) / (0.25 * Math.sqrt(T));
    const exact = 1 - 0.5 * (1 + erf(d / Math.SQRT2));
    expect(Math.abs(mean - exact)).toBeLessThan(4 * stderr + 1e-4);
  });

  it('is worth less the lower the correlation, which is the whole point', () => {
    // Less correlated legs diverge more, so the WORST of them is lower. A
    // worst-of note is therefore cheaper to the client, and an issuer can pay
    // a bigger coupon on it. A sampler with the correlation sign flipped would
    // fail here even while matching a symmetric closed form.
    const K = 0.85;
    const probs = [-0.6, 0, 0.6, 0.95].map((rho) => {
      const market = basketMarket([0.25, 0.25], [0.02, 0.02], [
        [1, rho],
        [rho, 1],
      ]);
      return mcTerminal(market, (perf) => (perf > K ? 1 : 0), 200_000).mean;
    });
    for (let i = 1; i < probs.length; i++) expect(probs[i]).toBeGreaterThan(probs[i - 1]);
  });

  it('refuses the combinations it cannot price honestly', () => {
    const corr = [
      [1, 0.4],
      [0.4, 1],
    ];
    // A basket used to refuse `market.quanto` outright, because one
    // `corrEqFx` cannot describe every leg. The engine now takes ONE quanto
    // block PER LEG, and reads `market.quanto` as the PRIMARY leg's block
    // (see model/market.ts's `legQuantoOf`). So this combination prices
    // instead of throwing. tests/basketQuanto.test.ts checks the drift it
    // produces against a hand-computed forward.
    const quanto: MarketData = {
      ...basketMarket([0.2, 0.3], [0.01, 0.02], corr),
      quanto: { rateUnderlying: 0.04, fxVol: 0.1, corrEqFx: -0.3 },
    };
    expect(() => new PathBatchGenerator(1, 4, 100, quanto, 0.25)).not.toThrow();

    // A per-step vol schedule is built from ONE surface at ONE risk strike.
    const perStep: MarketData = {
      ...basketMarket([0.2, 0.3], [0.01, 0.02], corr),
      volPerStep: [0.2, 0.21, 0.22, 0.23],
    };
    expect(() => new PathBatchGenerator(1, 4, 100, perStep, 0.25)).toThrow(/per-step vol/i);
  });

  it('keeps a perfectly correlated pair simulable, rather than failing to factor', () => {
    // Correlation exactly 1 is positive SEMI-definite, so the Cholesky factor
    // has a zero pivot. That is legitimate, not an error: the second leg is a
    // deterministic function of the first.
    const L = choleskyLower([
      [1, 1],
      [1, 1],
    ]);
    expect(L[1][1]).toBe(0);
    expect(Number.isFinite(L[1][0])).toBe(true);
  });
});

/** Abramowitz-Stegun 7.1.26, plenty for a test-side sanity value. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
}
