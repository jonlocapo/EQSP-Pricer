import { describe, expect, it } from 'vitest';
import { downAndInPut } from '../src/engine/blackScholes';
import { makeDf } from '../src/engine/discount';
import { runMc } from '../src/engine/mc';
import type { MarketData } from '../src/model/market';
import type { PathOutcome, PayoffEvaluator } from '../src/engine/payoffs/types';

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };
const s0 = 100;
const k = 100;
const barrier = 70;
const t = 1;
const nSteps = 252;
const dtYears = t / nSteps;
const numPaths = 200_000;
const seed = 777;

function makeDownAndInPutEvaluator(strike: number, b: number): PayoffEvaluator {
  const df = makeDf(market.rate);
  return (spots: Float64Array): PathOutcome => {
    let kiEvent = false;
    let minS = spots[0];
    for (let i = 1; i < spots.length; i++) {
      if (spots[i] < minS) minS = spots[i];
    }
    if (minS < b) kiEvent = true;
    const sT = spots[spots.length - 1];
    const intrinsic = kiEvent ? Math.max(strike - sT, 0) : 0;
    const pvPct = ((intrinsic / s0) * 100) * df(t);
    return { pvPct, kiEvent, lifeYears: t };
  };
}

describe('runMc vs Reiner-Rubinstein (down-and-in put, daily monitoring)', () => {
  it('matches the continuity-corrected closed form within tolerance', () => {
    const evaluator = makeDownAndInPutEvaluator(k, barrier);
    const result = runMc({ numPaths, seed, antithetic: true, nSteps, dtYears, s0, market, evaluator });

    // Broadie-Glasserman-Kou continuity correction for discrete monitoring.
    const correctedBarrier = barrier * Math.exp(-0.5826 * market.vol * Math.sqrt(dtYears));
    const closedForm =
      (downAndInPut(s0, k, correctedBarrier, t, market.vol, market.rate, market.divYield) / s0) * 100;

    expect(Math.abs(result.pvPct - closedForm)).toBeLessThan(0.5);
  });
});
