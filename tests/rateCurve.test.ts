import { describe, expect, it } from 'vitest';
import { makeDf, rateAt } from '../src/engine/discount';
import { runMc } from '../src/engine/mc';
import { buildGrid } from '../src/engine/schedule';
import { DEFAULT_COUPON_SPEC } from '../src/state/tradeStore';
import type { MarketData } from '../src/model/market';
import type { PathOutcome } from '../src/engine/payoffs/types';
import { computeCacheKey, gridTimesDigest } from '../src/engine/pathCache';

const CURVE = [
  { tYears: 0.25, rate: 0.02 },
  { tYears: 1, rate: 0.03 },
  { tYears: 2, rate: 0.035 },
  { tYears: 5, rate: 0.04 },
];

const MARKET: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

describe('rateAt', () => {
  it('hits the exact points and interpolates linearly between them', () => {
    expect(rateAt(CURVE, 0.25)).toBeCloseTo(0.02, 12);
    expect(rateAt(CURVE, 1)).toBeCloseTo(0.03, 12);
    expect(rateAt(CURVE, 1.5)).toBeCloseTo(0.0325, 12);
    expect(rateAt(CURVE, 0.625)).toBeCloseTo(0.025, 12);
  });

  it('holds flat outside the quoted range, never extrapolates', () => {
    expect(rateAt(CURVE, 0.1)).toBeCloseTo(0.02, 12);
    expect(rateAt(CURVE, 10)).toBeCloseTo(0.04, 12);
  });
});

describe('makeDf with a curve', () => {
  it('discounts with the interpolated rate: df(t) = exp(-r(t)*t)', () => {
    const df = makeDf(MARKET.rate, CURVE);
    expect(df(0)).toBeCloseTo(1, 12);
    expect(df(0.25)).toBeCloseTo(Math.exp(-0.02 * 0.25), 12);
    expect(df(2)).toBeCloseTo(Math.exp(-0.035 * 2), 12);
    expect(df(1.5)).toBeCloseTo(Math.exp(-0.0325 * 1.5), 12);
  });

  it('stays bit-identical to the flat discountRate path when no curve is given', () => {
    const flat = makeDf(0.02);
    const withSpreadFlat = makeDf(0.02, undefined, 25);
    expect(flat(3.7)).toBeCloseTo(Math.exp(-0.02 * 3.7), 15);
    expect(withSpreadFlat(3.7)).toBeCloseTo(Math.exp(-(0.02 + 0.0025) * 3.7), 15);
  });
});

describe('curve consistency — drift and discounting agree', () => {
  it('E[S_T]*df(T) reproduces the analytic forward: the curve cancels out of the forward', () => {
    // Under a rate curve, the drift uses r(t) per step and discounting uses
    // the same r(t). The curve must therefore cancel: E[S_T]·df(T) =
    // S0·exp(-q·T), exactly as with a flat rate. This pins the mutual
    // consistency of the two uses of the curve — the property that keeps a
    // capital-guaranteed bond floor priced right. The test uses a LINEAR
    // terminal payoff (the raw terminal ratio), the only payoff that
    // exposes the forward directly.
    const grid = buildGrid({ ...DEFAULT_COUPON_SPEC, callType: 'none' as const, barrierType: 'european' as const });
    const nSteps = grid.nSteps;
    const T = 1;
    // The payoff is the DISCOUNTED terminal ratio: pvPct = 100·(S_T/S0)·df(T),
    // with df built from the same curve the drift runs on. Its expectation
    // must equal the analytic forward, 100·exp(-q·T) — the curve cancels.
    const df = makeDf(MARKET.rate, CURVE);
    const evaluator = (spots: Float64Array): PathOutcome => ({
      pvPct: 100 * (spots[nSteps] / spots[0]) * df(T),
      lifeYears: T,
    });
    const res = runMc({
      numPaths: 100_000,
      seed: 42,
      antithetic: true,
      nSteps,
      dtYears: grid.stepDt,
      s0: MARKET.spot,
      market: { ...MARKET, rateCurve: CURVE },
      evaluator,
    });
    // The forward identity: E[S_T/S0]·df(T)·100 = 100·exp(-q·T).
    const expected = 100 * Math.exp(-MARKET.divYield * T);
    expect(Math.abs(res.pvPct - expected)).toBeLessThan(0.1);
  });
});

describe('rate curve cache key', () => {
  it('a curve change invalidates the path cache (different key, same flat rate)', () => {
    const params = {
      s0: 100,
      market: MARKET,
      numPaths: 1000,
      seed: 1,
      antithetic: true,
      nSteps: 252,
      timesKey: gridTimesDigest(buildGrid(spec())),
    };
    const flatKey = computeCacheKey(params);
    const curvedKey = computeCacheKey({ ...params, market: { ...MARKET, rateCurve: CURVE } });
    expect(curvedKey).not.toBe(flatKey);
  });
});

function spec() {
  return { ...DEFAULT_COUPON_SPEC, callType: 'none' as const, barrierType: 'european' as const };
}
