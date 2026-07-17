import { describe, expect, it } from 'vitest';
import { bsCall, bsPut } from '../src/engine/blackScholes';
import { makeDf } from '../src/engine/discount';
import { runMc } from '../src/engine/mc';
import type { MarketData } from '../src/model/market';
import type { PathOutcome, PayoffEvaluator } from '../src/engine/payoffs/types';

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };
const s0 = 100;
const k = 100;
const t = 1;
const nSteps = 252;
const dtYears = t / nSteps;
const numPaths = 200_000;
const seed = 12345;

function makeVanillaEvaluator(strike: number, isCall: boolean): PayoffEvaluator {
  const df = makeDf(market.rate);
  return (spots: Float64Array): PathOutcome => {
    const sT = spots[spots.length - 1];
    const intrinsic = isCall ? Math.max(sT - strike, 0) : Math.max(strike - sT, 0);
    const pvPct = ((intrinsic / s0) * 100) * df(t);
    return { pvPct, lifeYears: t };
  };
}

describe('runMc vs Black-Scholes (vanilla)', () => {
  it('prices a call within tolerance of the closed form', () => {
    const evaluator = makeVanillaEvaluator(k, true);
    const result = runMc({ numPaths, seed, antithetic: true, nSteps, dtYears, s0, market, evaluator });

    const bsPrice = (bsCall(s0, k, t, market.vol, market.rate, market.divYield) / s0) * 100;
    const tol = Math.max(3 * result.stderrPct, 0.15);
    expect(Math.abs(result.pvPct - bsPrice)).toBeLessThan(tol);
  });

  it('prices a put within tolerance of the closed form', () => {
    const evaluator = makeVanillaEvaluator(k, false);
    const result = runMc({ numPaths, seed, antithetic: true, nSteps, dtYears, s0, market, evaluator });

    const bsPrice = (bsPut(s0, k, t, market.vol, market.rate, market.divYield) / s0) * 100;
    const tol = Math.max(3 * result.stderrPct, 0.15);
    expect(Math.abs(result.pvPct - bsPrice)).toBeLessThan(tol);
  });

  it('respects put-call parity within MC noise', () => {
    const callEval = makeVanillaEvaluator(k, true);
    const putEval = makeVanillaEvaluator(k, false);
    const callResult = runMc({ numPaths, seed, antithetic: true, nSteps, dtYears, s0, market, evaluator: callEval });
    const putResult = runMc({ numPaths, seed, antithetic: true, nSteps, dtYears, s0, market, evaluator: putEval });

    const df = makeDf(market.rate);
    const forwardPct = ((s0 * Math.exp((market.rate - market.divYield) * t) - k) / s0) * 100 * df(t);
    const parityDiff = callResult.pvPct - putResult.pvPct - forwardPct;
    const tol = Math.max(3 * Math.sqrt(callResult.stderrPct ** 2 + putResult.stderrPct ** 2), 0.15);
    expect(Math.abs(parityDiff)).toBeLessThan(tol);
  });
});
