import { describe, expect, it } from 'vitest';
import { executePriceRequest, type PricingHooks } from '../src/worker/pricing';
import { __clearPathCacheForTests } from '../src/engine/pathCache';
import { validateAccumulator } from '../src/services/validation';
import type { MarketData } from '../src/model/market';
import type { AccumulatorSpec } from '../src/model/product';

/**
 * An accumulator's strike and its knock-out trigger have a required ordering,
 * and the SOLVER must respect it, not merely the validator.
 *
 * A solved value is written straight back into its own field, and that field is
 * greyed out precisely because it is the solve target. So an illegal solved
 * value leaves an invalid spec the user cannot edit, which disables live
 * repricing, and nothing recalculates again. An unreachable target must
 * therefore fail loudly rather than succeed illegally.
 */

const hooks: PricingHooks = { onProgress: () => {}, isCancelled: () => false, yieldNow: () => Promise.resolve() };

const decumulator: AccumulatorSpec = {
  kind: 'accumulator',
  direction: 'decumulate',
  underlyings: [{ name: 'NESN' }],
  strikePct: 103,
  upfrontPct: 0.93,
  tenorYears: 0.5,
  settlementFrequency: 'monthly',
  dailyShares: 70,
  koTriggerPct: 95,
  koSettlement: 'ko1',
  gearing: 2,
  guaranteePeriods: 2,
};

/** Mirror image: knocks out ABOVE the strike, so the ordering flips. The
 * bounds are INCLUSIVE at the trigger, since a strike sitting exactly on the
 * knock-out is a real structure. */
const accumulator: AccumulatorSpec = { ...decumulator, direction: 'accumulate', strikePct: 97, koTriggerPct: 110 };

const market: MarketData = { spot: 80.21, vol: 0.18, rate: -0.0005, divYield: 0.02, currency: 'CHF' };

async function solve(
  spec: AccumulatorSpec,
  kind: 'strike' | 'koTrigger',
  costs?: MarketData['costs'],
): Promise<number> {
  __clearPathCacheForTests();
  const r = await executePriceRequest(
    {
      id: 't',
      product: spec,
      market: { ...market, costs },
      mc: { numPaths: 20_000, seed: 42, antithetic: true },
      solve: { kind },
      greeks: false,
    },
    hooks,
  );
  return r!.solvedValue!;
}

describe('accumulator solve bounds respect the knock-out ordering', () => {
  it('keeps a decumulator strike above the trigger, even under absurd costs', async () => {
    // 500% funding is what the report used. The bracket, not the cost level, is
    // what has to hold this, so an extreme input is the right test.
    for (const bp of [0, 5_000, 50_000]) {
      const strike = await solve(decumulator, 'strike', { fundingSpreadBp: bp, borrowCostBp: 0, feePct: 0 });
      expect(strike).toBeGreaterThanOrEqual(decumulator.koTriggerPct);
      expect(validateAccumulator({ ...decumulator, strikePct: strike }, market).valid).toBe(true);
    }
  }, 60_000);

  it('keeps an accumulator strike below the trigger, the mirror case', async () => {
    const strike = await solve(accumulator, 'strike');
    expect(strike).toBeLessThanOrEqual(accumulator.koTriggerPct);
    expect(validateAccumulator({ ...accumulator, strikePct: strike }, market).valid).toBe(true);
  }, 60_000);

  it('solves a decumulator trigger BELOW the strike, not above spot', async () => {
    // The old bracket was lo 100.5, hi 200 for both directions, which searched
    // entirely on the wrong side of spot for a decumulator.
    const ko = await solve(decumulator, 'koTrigger');
    expect(ko).toBeLessThanOrEqual(decumulator.strikePct);
    expect(validateAccumulator({ ...decumulator, koTriggerPct: ko }, market).valid).toBe(true);
  }, 60_000);

  it('solves an accumulator trigger ABOVE the strike, or says it cannot', async () => {
    // The mirror of the case above. This particular spec, struck 3% below spot,
    // is worth more than any upfront a legal trigger can produce, so an honest
    // "no solution" is the correct answer and not a regression: the bracket is
    // WIDER than the one it replaced, which started at 100.5.
    let ko: number | null = null;
    let message = '';
    try {
      ko = await solve(accumulator, 'koTrigger');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    if (ko === null) {
      expect(message).toMatch(/no solution|not reachable/i);
      // Whatever it reports, it must have searched the LEGAL side.
      expect(message).toMatch(/\[9[0-9]|\[1[0-9][0-9]/);
    } else {
      expect(ko).toBeGreaterThanOrEqual(accumulator.strikePct);
      expect(validateAccumulator({ ...accumulator, koTriggerPct: ko }, market).valid).toBe(true);
    }
  }, 60_000);

  it('fails loudly rather than returning an illegal answer when the target is unreachable', async () => {
    // An upfront no legal strike can reach. The old code would happily walk
    // through the trigger to find one; the only acceptable outcomes now are a
    // legal strike or a clean error the UI can recover from.
    const impossible: AccumulatorSpec = { ...decumulator, upfrontPct: -500 };
    let solved: number | null = null;
    let message = '';
    try {
      solved = await solve(impossible, 'strike');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    if (solved === null) {
      expect(message).toMatch(/no solution|not reachable/i);
    } else {
      expect(solved).toBeGreaterThanOrEqual(impossible.koTriggerPct);
    }
  }, 60_000);
});
