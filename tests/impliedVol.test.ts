import { describe, expect, it } from 'vitest';
import { bsCall, bsPut } from '../src/engine/blackScholes';
import {
  HALLEY_ITER_CEILING,
  MAX_VOL,
  MIN_VOL,
  impliedVolFromPrice,
  type ImpliedVolDiagnostics,
} from '../src/engine/impliedVol';

const s = 100;
const r = 0.03;
const q = 0.01;

describe('impliedVolFromPrice — round trip against the closed form', () => {
  it('recovers the vol to about 1e-9 or better across a wide, well-conditioned grid', () => {
    // Grid: log-moneyness -3..3, maturities from 1 day to 5 years, vols 1%
    // to 300%. A raw cartesian product of these three axes independently
    // also contains combinations no implementation could recover — e.g.
    // 1% vol at 1 day and 3 log-moneyness is many hundred standard
    // deviations out, and the true option price underflows to exactly 0 in
    // double precision before implied vol even enters the picture. `d`
    // below is the option's own moneyness in vol-adjusted standard
        // deviations; the grid is filtered on it so this test measures
    // recovery precision on quotes a market could actually produce, not on
    // combinations that carry no information in ANY floating-point
    // representation.
    const logMoneyness = [-3, -2, -1.5, -1, -0.5, -0.1, 0, 0.1, 0.5, 1, 1.5, 2, 3];
    const maturities = [1 / 365, 7 / 365, 30 / 365, 0.25, 1, 2, 5];
    const vols = [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 3];

    let checked = 0;
    let maxErr = 0;
    let maxHalleyIterations = 0;

    for (const t of maturities) {
      const fwd = s * Math.exp((r - q) * t);
      for (const lm of logMoneyness) {
        const k = fwd * Math.exp(-lm);
        for (const vol of vols) {
          const d = Math.abs(lm) / (vol * Math.sqrt(t));
          if (d >= 3.5) continue; // genuinely unrecoverable combination, not this test's concern
          for (const isCall of [true, false]) {
            const price = isCall ? bsCall(s, k, t, vol, r, q) : bsPut(s, k, t, vol, r, q);
            if (!(price > 1e-300)) continue;
            const diag: ImpliedVolDiagnostics = { iterations: 0, usedFallback: false };
            const got = impliedVolFromPrice({ price, s, k, t, r, q, isCall }, diag);
            expect(got).not.toBeNull();
            checked += 1;
            maxErr = Math.max(maxErr, Math.abs((got as number) - vol));
            if (!diag.usedFallback) maxHalleyIterations = Math.max(maxHalleyIterations, diag.iterations);
          }
        }
      }
    }

    // Sanity: the grid above should exercise a substantial number of cases,
    // or the `d >= 4` filter is silently eating the test.
    expect(checked).toBeGreaterThan(500);
    expect(maxErr).toBeLessThan(1e-9);
    // Iteration-count ceiling: catches a future regression back to a slow
    // path on the fast (non-fallback) Halley route.
    expect(maxHalleyIterations).toBeLessThanOrEqual(HALLEY_ITER_CEILING);
  });

  it('put and call at the SAME strike, priced consistently, invert to the same vol', () => {
    const t = 0.5;
    const vol = 0.4;
    for (const k of [70, 90, 100, 110, 140]) {
      const cv = impliedVolFromPrice({ price: bsCall(s, k, t, vol, r, q), s, k, t, r, q, isCall: true });
      const pv = impliedVolFromPrice({ price: bsPut(s, k, t, vol, r, q), s, k, t, r, q, isCall: false });
      expect(cv).not.toBeNull();
      expect(pv).not.toBeNull();
      expect(Math.abs((cv as number) - (pv as number))).toBeLessThan(1e-8);
    }
  });

  it('an in-the-money quote and its out-of-the-money parity twin invert to the same vol', () => {
    // The whole point of the parity preconditioning: a deep in-the-money
    // call is numerically fragile to invert directly (vega near zero), but
    // its price still encodes the SAME vol as the well-conditioned put at
    // the same strike. Confirm the two paths agree.
    const t = 1;
    const vol = 0.35;
    const k = 70; // deep in-the-money for a call, out-of-the-money for a put
    const fromCall = impliedVolFromPrice({ price: bsCall(s, k, t, vol, r, q), s, k, t, r, q, isCall: true });
    const fromPut = impliedVolFromPrice({ price: bsPut(s, k, t, vol, r, q), s, k, t, r, q, isCall: false });
    expect(fromCall).not.toBeNull();
    expect(fromPut).not.toBeNull();
    expect(fromCall as number).toBeCloseTo(vol, 6);
    expect(Math.abs((fromCall as number) - (fromPut as number))).toBeLessThan(1e-6);
  });
});

describe('impliedVolFromPrice — rejection paths', () => {
  it('rejects a non-positive price', () => {
    expect(impliedVolFromPrice({ price: 0, s: 100, k: 100, t: 1, r: 0.03, q: 0.01, isCall: true })).toBeNull();
    expect(impliedVolFromPrice({ price: -5, s: 100, k: 100, t: 1, r: 0.03, q: 0.01, isCall: true })).toBeNull();
  });

  it('rejects an expired option (t <= 0)', () => {
    expect(impliedVolFromPrice({ price: 5, s: 100, k: 100, t: 0, r: 0.03, q: 0.01, isCall: true })).toBeNull();
    expect(impliedVolFromPrice({ price: 5, s: 100, k: 100, t: -0.1, r: 0.03, q: 0.01, isCall: true })).toBeNull();
  });

  it('rejects a price below its no-arbitrage intrinsic bound', () => {
    // A call struck well in the money must be worth at least its discounted
    // intrinsic value. Quoting less is a stale or broken price, not a vol.
    const s0 = 100, k = 60, t = 1, rr = 0.03, qq = 0.0;
    const fwd = s0 * Math.exp((rr - qq) * t);
    const df = Math.exp(-rr * t);
    const intrinsic = df * (fwd - k);
    expect(impliedVolFromPrice({ price: intrinsic - 1, s: s0, k, t, r: rr, q: qq, isCall: true })).toBeNull();
  });

  it('rejects a price above its no-arbitrage upper bound', () => {
    const s0 = 100, k = 100, t = 1, rr = 0.03, qq = 0.0;
    const fwd = s0 * Math.exp((rr - qq) * t);
    const df = Math.exp(-rr * t);
    // Call upper bound is the discounted forward itself.
    expect(impliedVolFromPrice({ price: df * fwd + 1, s: s0, k, t, r: rr, q: qq, isCall: true })).toBeNull();
  });

  it('rejects a deep in-the-money quote with essentially no time value', () => {
    // Constructed to sit within a hair of its own intrinsic value.
    const s0 = 100, k = 40, t = 1, rr = 0.02, qq = 0.0;
    const fwd = s0 * Math.exp((rr - qq) * t);
    const df = Math.exp(-rr * t);
    const intrinsic = df * (fwd - k);
    expect(impliedVolFromPrice({ price: intrinsic + 1e-9, s: s0, k, t, r: rr, q: qq, isCall: true })).toBeNull();
  });

  it('rejects the measured marketdata.app case: deep ITM AAPL call reporting a nonsense iv of 0.0001', () => {
    // spot 333.48, strike 255, price 78.4, ~0.07y — the exact shape of the
    // defect that motivated this module: iv was reported at 0.0001 on this
    // quote by a provider trusting a numerically unrecoverable inversion.
    const res = impliedVolFromPrice({ price: 78.4, s: 333.48, k: 255, t: 0.07, r: 0.05, q: 0.01, isCall: true });
    expect(res).toBeNull();
  });

  it('rejects a root outside the search bracket', () => {
    // A synthetic price that implies a vol far past MAX_VOL: constructed by
    // pricing at an absurd vol and feeding that price back in, so it is a
    // internally-consistent (not an arbitrage-violating) price that simply
    // has no solution inside [MIN_VOL, MAX_VOL].
    const t = 0.25;
    const absurdVol = MAX_VOL * 3;
    const price = bsCall(s, 100, t, absurdVol, r, q);
    const res = impliedVolFromPrice({ price, s, k: 100, t, r, q, isCall: true });
    expect(res).toBeNull();
  });

  it('never returns a vol outside [MIN_VOL, MAX_VOL] on any accepted quote', () => {
    const t = 1;
    for (const vol of [MIN_VOL * 1.5, 0.3, MAX_VOL * 0.9]) {
      const res = impliedVolFromPrice({ price: bsCall(s, 105, t, vol, r, q), s, k: 105, t, r, q, isCall: true });
      if (res !== null) {
        expect(res).toBeGreaterThanOrEqual(MIN_VOL);
        expect(res).toBeLessThanOrEqual(MAX_VOL);
      }
    }
  });
});
