import { describe, expect, it } from 'vitest';
import { runMc } from '../src/engine/mc';
import { makeEvaluator } from '../src/engine/payoffs';
import { buildGrid } from '../src/engine/schedule';
import { makeDf } from '../src/engine/discount';
import { discountRate, type MarketData } from '../src/model/market';
import type { ProductSpec } from '../src/model/product';
import {
  DEFAULT_COUPON_SPEC,
  DEFAULT_PARTICIPATION,
  DEFAULT_ACCUMULATOR,
} from '../src/state/tradeStore';

/**
 * C3 of the worst-of basket prerequisites: measure and pin the
 * antithetic-sampling noise reduction per product family.
 *
 * Antithetic pairing works because flipping the random numbers flips the
 * payoff in a predictable way. A worst-of minimum breaks that. The payoff is
 * a min across assets, so the pairing helps less. Without a measured baseline
 * for the CURRENT single-asset engine, nobody can later tell whether a
 * worst-of stderr is "bad" or "normal". This test records the baseline. It
 * gives the basket work a number to compare against.
 *
 * MEASURED BASELINE (seed 7, 50_000 paths, market
 * { spot 100, vol 0.25, rate 0.02, divYield 0.02, EUR }):
 *   coupon (European barrier):      plain 0.03296, antithetic 0.03239, ratio 1.018
 *   participation booster:          plain 0.14659, antithetic 0.05834, ratio 2.513
 *   accumulator:                    plain 0.05754, antithetic 0.03823, ratio 1.505
 */

const MARKET: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

const NUM_PATHS = 50_000;
const SEED = 7;

function priceFamily(spec: ProductSpec, antithetic: boolean) {
  const grid = buildGrid(spec);
  const ctx = { market: MARKET, grid, df: makeDf(discountRate(MARKET)) };
  const evaluator = makeEvaluator(spec, ctx);
  return runMc({
    numPaths: NUM_PATHS,
    seed: SEED,
    antithetic,
    nSteps: grid.nSteps,
    dtYears: grid.stepDt,
    s0: MARKET.spot,
    market: MARKET,
    evaluator,
  });
}

function assertReduction(spec: ProductSpec): void {
  const plain = priceFamily(spec, false);
  const anti = priceFamily(spec, true);
  // The property: antithetic sampling strictly reduces the standard error at
  // the same path count. Antithetic must not change the ANSWER, only the
  // error, so the two means agree within a few stderrs.
  expect(anti.stderrPct).toBeLessThan(plain.stderrPct);
  expect(Math.abs(anti.pvPct - plain.pvPct)).toBeLessThan(
    5 * Math.max(plain.stderrPct, anti.stderrPct),
  );
}

describe('C3: antithetic-sampling noise reduction baseline', () => {
  it('coupon with a European barrier: antithetic strictly lowers stderr', () => {
    assertReduction({ ...DEFAULT_COUPON_SPEC, barrierType: 'european' });
  });

  it('participation booster: antithetic strictly lowers stderr', () => {
    assertReduction(DEFAULT_PARTICIPATION);
  });

  it('accumulator: antithetic strictly lowers stderr', () => {
    assertReduction(DEFAULT_ACCUMULATOR);
  });
});
