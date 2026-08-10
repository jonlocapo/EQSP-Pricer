import { describe, expect, it } from 'vitest';
import { executePriceRequest } from '../src/worker/pricing';
import { __clearPathCacheForTests } from '../src/engine/pathCache';
import type { PricingHooks } from '../src/worker/pricing';
import type { MarketData } from '../src/model/market';
import type { CouponProductSpec, ParticipationSpec } from '../src/model/product';

/**
 * The observables cache must identify WHICH evaluator produced a slice, not
 * only which grid it was built on.
 *
 * `PathObservables.eventPerf` means a different thing in each family. The
 * coupon family fills it at every merged coupon or call observation. The
 * participation family leaves it empty. The cache is one module-level slot per
 * worker that survives across requests and across product pages, so a key that
 * described only the grid let one family replay the other's slices.
 *
 * The damage is silent. A coupon note reading an empty `eventPerf` gets
 * `undefined` at every observation, every `perf >= barrier` test is false, and
 * the note pays no coupons and never autocalls. No error, no log, just a wrong
 * price.
 */

const hooks: PricingHooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };
const mc = { numPaths: 40_000, seed: 42, antithetic: true } as const;

/**
 * A one-year note whose only observation is at maturity: annual coupons, no
 * autocall, European barrier. Its grid reduces to `times = [0, 1]` with one
 * coupon observation, which is exactly what the participation note below
 * reduces to. That coincidence is what used to make the two keys equal.
 */
const coupon: CouponProductSpec = {
  kind: 'coupon',
  underlyings: [{ name: 'A' }],
  notional: 1_000_000,
  tenorYears: 1,
  reofferPct: 100,
  issuePricePct: 100,
  barrierType: 'european',
  kiBarrierPct: 60,
  putStrikePct: 100,
  downsideLeveragePct: 100,
  callType: 'none',
  callFrequency: 'annual',
  callFromPeriod: 1,
  callBarrierPct: 100,
  stepDownPct: 0,
  customCallBarriersPct: [],
  // Conditional, so the coupon depends on reading eventPerf. A fixed coupon
  // would pay regardless and would hide the fault.
  couponType: 'conditional',
  couponFrequency: 'annual',
  couponBarrierPct: 60,
  couponPaPct: 8,
  acCouponType: 'none',
  acCouponPct: 0,
};

const participation: ParticipationSpec = {
  kind: 'participation',
  underlyings: [{ name: 'A' }],
  notional: 1_000_000,
  tenorYears: 1,
  reofferPct: 100,
  issuePricePct: 100,
  upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
  downside: { strikePct: 100, leveragePct: 100, barrierType: 'european', kiBarrierPct: 60, twinWinPct: 0 },
  bonusPct: 0,
  protectionPct: 0,
};

async function price(product: CouponProductSpec | ParticipationSpec, id: string) {
  const r = await executePriceRequest(
    { id, product, market, mc, solve: { kind: 'none' }, greeks: false },
    hooks,
  );
  expect(r).not.toBeNull();
  return r!;
}

describe('one product family never replays another family observables', () => {
  it('a conditional coupon note prices the same whether or not a participation ran first', async () => {
    // Alone, from a cold cache. This is the correct answer.
    __clearPathCacheForTests();
    const alone = await price(coupon, 'coupon-alone');

    // Now the sequence a user actually performs: price the participation on
    // one page, switch page, price the coupon note. Same market, same MC
    // settings, same one-observation grid, one shared cache.
    __clearPathCacheForTests();
    await price(participation, 'participation-first');
    const afterSwitch = await price(coupon, 'coupon-after-switch');

    // Bit-identical. The second run may legitimately reuse the raw PATHS,
    // which is the whole point of the cache, but it must recompute the
    // observables.
    expect(afterSwitch.pvPct).toBeCloseTo(alone.pvPct, 9);
    expect(afterSwitch.stderrPct).toBeCloseTo(alone.stderrPct, 9);
  });

  it('and it really does pay its conditional coupons, so the check above has something to catch', async () => {
    __clearPathCacheForTests();
    const withCoupon = await price(coupon, 'with-coupon');
    __clearPathCacheForTests();
    const zeroCoupon = await price({ ...coupon, couponPaPct: 0 }, 'zero-coupon');

    // If eventPerf were empty the conditional coupon would never pay, and
    // these two would be the same note. An 8% one-year coupon is worth points.
    expect(withCoupon.pvPct - zeroCoupon.pvPct).toBeGreaterThan(3);
  });
});
