import { describe, expect, it } from 'vitest';
import { executePriceRequest } from '../src/worker/pricing';
import { __clearPathCacheForTests } from '../src/engine/pathCache';
import type { PricingHooks } from '../src/worker/pricing';
import type { MarketData } from '../src/model/market';
import type { CouponProductSpec, ParticipationSpec } from '../src/model/product';

/**
 * The three numbers a client reads as risk: P(loss), Expected Shortfall, and
 * the histogram. They describe the OUTCOME distribution, which is a different
 * object from the mean estimator, and they had two faults that both made a
 * note look safer or riskier than it is.
 */

const hooks: PricingHooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

const market: MarketData = { spot: 100, vol: 0.28, rate: 0.03, divYield: 0.02, currency: 'EUR' };

const reverseConvertible: CouponProductSpec = {
  kind: 'coupon',
  underlyings: [{ name: 'A' }],
  notional: 1_000_000,
  tenorYears: 3,
  reofferPct: 100,
  issuePricePct: 100,
  barrierType: 'european',
  kiBarrierPct: 60,
  putStrikePct: 100,
  downsideLeveragePct: 100,
  callType: 'none',
  callFrequency: 'quarterly',
  callFromPeriod: 1,
  callBarrierPct: 100,
  stepDownPct: 0,
  customCallBarriersPct: [],
  couponType: 'fixed',
  couponFrequency: 'quarterly',
  couponBarrierPct: 60,
  couponPaPct: 8,
  acCouponType: 'none',
  acCouponPct: 0,
};

/** Capital guaranteed at 100%: the redemption cannot fall below par on ANY
 * path, whatever the underlying does. */
const capitalGuaranteed: ParticipationSpec = {
  kind: 'participation',
  underlyings: [{ name: 'A' }],
  notional: 1_000_000,
  tenorYears: 5,
  reofferPct: 100,
  issuePricePct: 100,
  upside: { strikePct: 100, participationPct: 60, variant: { variant: 'vanilla' } },
  downside: { strikePct: 100, leveragePct: 100, barrierType: 'none', kiBarrierPct: 0, twinWinPct: 0 },
  bonusPct: 0,
  protectionPct: 100,
};

async function price(product: CouponProductSpec | ParticipationSpec, antithetic: boolean) {
  __clearPathCacheForTests();
  const r = await executePriceRequest(
    {
      id: `risk-${product.kind}-${antithetic}`,
      product,
      market,
      mc: { numPaths: 100_000, seed: 3, antithetic },
      solve: { kind: 'none' },
      greeks: false,
    },
    hooks,
  );
  expect(r).not.toBeNull();
  return r!;
}

describe('the loss reference sits in the same money as the samples', () => {
  it('a 100% capital-guaranteed note reports no loss probability', async () => {
    const r = await price(capitalGuaranteed, true);

    // Every sample is a PV, because the evaluators discount each cashflow.
    // Comparing a PV against an undiscounted 100 counted the time value of
    // money as a loss, and this note reported a 73% chance of losing capital
    // when its redemption cannot fall below par. Both sides now sit in
    // today's money.
    expect(r.diagnostics.pLoss).toBe(0);

    // The worst outcome is the guarantee itself, discounted: 100 * df(5y).
    // At 3% that is about 86.07, and the expected shortfall must not be
    // below it.
    const floorPv = 100 * Math.exp(-0.03 * 5);
    expect(r.diagnostics.expectedShortfall5!).toBeGreaterThanOrEqual(floorPv - 1e-6);
  });

  it('a barrier note still reports a real loss probability, so the fix did not just zero the number', async () => {
    const r = await price(reverseConvertible, true);
    expect(r.diagnostics.pLoss!).toBeGreaterThan(0.05);
    expect(r.diagnostics.pLoss!).toBeLessThan(0.5);
  });
});

describe('the outcome distribution does not depend on the variance-reduction scheme', () => {
  /**
   * The invariant that catches the antithetic fault. Antithetic sampling is a
   * variance reduction on the MEAN. It must not change the distribution of
   * outcomes, because the note pays what it pays regardless of how the pricer
   * chose its random numbers.
   *
   * Averaging a path with its mirror destroyed the tail: a knocked-in path
   * redeeming at 55 and its mirror redeeming at 100 plus coupons averaged to
   * something near par, so the pair never landed in the loss region. Measured
   * on this note, the 5% expected shortfall read 82.23 when the real figure is
   * 54.14, and the 1% read 78.98 against 46.17.
   */
  it('antithetic and plain sampling agree on P(loss) and on expected shortfall', async () => {
    const anti = await price(reverseConvertible, true);
    const plain = await price(reverseConvertible, false);

    // Same price, as always.
    expect(anti.pvPct).toBeCloseTo(plain.pvPct, 0);

    // And now the same tail. These are two independent samples of the same
    // distribution, so they agree to sampling error, not exactly.
    expect(anti.diagnostics.pLoss!).toBeCloseTo(plain.diagnostics.pLoss!, 2);
    expect(anti.diagnostics.expectedShortfall5!).toBeCloseTo(plain.diagnostics.expectedShortfall5!, 0);
    expect(anti.diagnostics.expectedShortfall1!).toBeCloseTo(plain.diagnostics.expectedShortfall1!, 0);
  });

  it('keeps one distribution sample per path, not one per antithetic pair', async () => {
    const anti = await price(reverseConvertible, true);
    // The histogram counts must total the path count. Half of that would mean
    // the pairs, not the paths, reached the distribution.
    const total = anti.diagnostics.histogram!.counts.reduce((a, b) => a + b, 0);
    expect(total).toBe(100_000);
  });
});
