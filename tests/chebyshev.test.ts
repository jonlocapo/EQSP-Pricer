import { describe, it, expect } from 'vitest';
import {
  buildChebyshevInterpolant,
  chebyshevLobattoSpotNodes,
} from '../src/engine/chebyshev';
import { bsCall, normCdf } from '../src/engine/blackScholes';

/** Standard normal pdf, used for the closed-form BS gamma reference. */
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function bsDelta(s: number, k: number, t: number, vol: number, r: number, q: number): number {
  const d1 = (Math.log(s / k) + (r - q + 0.5 * vol * vol) * t) / (vol * Math.sqrt(t));
  return Math.exp(-q * t) * normCdf(d1);
}

function bsGamma(s: number, k: number, t: number, vol: number, r: number, q: number): number {
  const d1 = (Math.log(s / k) + (r - q + 0.5 * vol * vol) * t) / (vol * Math.sqrt(t));
  return (Math.exp(-q * t) * normPdf(d1)) / (s * vol * Math.sqrt(t));
}

describe('chebyshev', () => {
  it('interpolates a smooth analytic function to ~1e-6 at off-node points (N=32)', () => {
    const N = 32;
    const lo = 1;
    const hi = 4;
    const f = (x: number) => Math.exp(x) * Math.sin(x);
    const nodesX = chebyshevLobattoSpotNodes(N, lo, hi);
    const nodesY = nodesX.map(f);
    const interp = buildChebyshevInterpolant(nodesX, nodesY);

    // Off-node evaluation points spread across the interval.
    const testPoints = [1.05, 1.37, 1.9, 2.31, 2.5, 2.77, 3.14, 3.6, 3.95];
    for (const x of testPoints) {
      const got = interp.eval(x);
      const want = f(x);
      expect(Math.abs(got - want)).toBeLessThan(1e-6);
    }
  });

  it('matches closed-form Black-Scholes delta and gamma via analytic differentiation (N=32)', () => {
    const N = 32;
    const K = 100;
    const T = 1;
    const vol = 0.25;
    const r = 0.02;
    const q = 0.02;
    const lo = 0.5 * K;
    const hi = 1.5 * K;

    const nodesX = chebyshevLobattoSpotNodes(N, lo, hi);
    const nodesY = nodesX.map((s) => bsCall(s, K, T, vol, r, q));
    const interp = buildChebyshevInterpolant(nodesX, nodesY);

    const interiorSpots = [55, 70, 85, 100, 115, 130, 145];
    for (const s of interiorSpots) {
      const pv = interp.eval(s);
      const pvWant = bsCall(s, K, T, vol, r, q);
      expect(Math.abs(pv - pvWant)).toBeLessThan(1e-3);

      const delta = interp.derivative(s);
      const deltaWant = bsDelta(s, K, T, vol, r, q);
      expect(Math.abs(delta - deltaWant)).toBeLessThan(1e-3);

      const gamma = interp.secondDerivative(s);
      const gammaWant = bsGamma(s, K, T, vol, r, q);
      expect(Math.abs(gamma - gammaWant)).toBeLessThan(1e-3);
    }
  });

  it('affine-map/chain-rule sanity: same closed-form check on a non-[-1,1], oddly-scaled interval', () => {
    // Deliberately narrow, off-center, non-round interval — a missing
    // 2/(hi-lo) factor (or a wrongly-applied one) would show up as a
    // scale-dependent error here, unlike the K=100 test above.
    const N = 32;
    const K = 43.25;
    const T = 0.75;
    const vol = 0.32;
    const r = 0.015;
    const q = 0.01;
    const lo = 30.1;
    const hi = 61.9;

    const nodesX = chebyshevLobattoSpotNodes(N, lo, hi);
    const nodesY = nodesX.map((s) => bsCall(s, K, T, vol, r, q));
    const interp = buildChebyshevInterpolant(nodesX, nodesY);

    const interiorSpots = [32, 38, 43.25, 50, 55, 60];
    for (const s of interiorSpots) {
      const delta = interp.derivative(s);
      const deltaWant = bsDelta(s, K, T, vol, r, q);
      expect(Math.abs(delta - deltaWant)).toBeLessThan(1e-3);

      const gamma = interp.secondDerivative(s);
      const gammaWant = bsGamma(s, K, T, vol, r, q);
      expect(Math.abs(gamma - gammaWant)).toBeLessThan(1e-3);
    }

    // Also check a much WIDER interval (large hi-lo) at the same time to
    // make sure the chain-rule scaling tracks interval width correctly in
    // both directions, not just one fixed constant.
    const wideLo = 5;
    const wideHi = 400;
    const wideNodesX = chebyshevLobattoSpotNodes(N, wideLo, wideHi);
    const wideNodesY = wideNodesX.map((s) => bsCall(s, K, T, vol, r, q));
    const wideInterp = buildChebyshevInterpolant(wideNodesX, wideNodesY);
    for (const s of [43.25, 100, 200]) {
      const delta = wideInterp.derivative(s);
      const deltaWant = bsDelta(s, K, T, vol, r, q);
      // Wider interval, same N => coarser resolution; looser (still tight) tolerance.
      expect(Math.abs(delta - deltaWant)).toBeLessThan(5e-2);
    }
  });
});
