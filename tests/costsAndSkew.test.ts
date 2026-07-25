import { describe, expect, it, beforeEach } from 'vitest';
import { executePriceRequest } from '../src/worker/pricing';
import type { PricingHooks } from '../src/worker/pricing';
import { __clearPathCacheForTests } from '../src/engine/pathCache';
import { buildVolSurface } from '../src/model/volSurface';
import type { CostParams, MarketData } from '../src/model/market';
import type { CouponProductSpec } from '../src/model/product';

/**
 * The DIRECTION each cost and the volatility skew move a solved coupon.
 *
 * Directions are asserted, because they are the economically meaningful
 * claim, and because they are easy to get backwards. The borrow sign in
 * this file's first draft was wrong, until it was measured. Magnitudes are
 * quoted in comments as of the reference case below. They are not pinned,
 * so ordinary MC noise cannot make this file fail spuriously.
 */

const hooks: PricingHooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

const baseMarket: MarketData = { spot: 100, vol: 0.25, rate: 0.03, divYield: 0.02, currency: 'EUR' };

const spec: CouponProductSpec = {
  kind: 'coupon',
  underlyings: [{ name: 'T' }],
  currency: 'EUR',
  notional: 1_000_000,
  tenorYears: 1,
  reofferPct: 98.5,
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
  couponType: 'conditional',
  couponFrequency: 'quarterly',
  couponBarrierPct: 60,
  couponPaPct: 8,
  acCouponType: 'none',
  acCouponPct: 0,
};

/** A normal equity skew: the 60% barrier carries 37% vol against 25% ATM. */
const skewSurface = buildVolSurface({
  spot: 100,
  source: 'test',
  slices: [
    {
      tYears: 1,
      puts: [
        { strike: 60, iv: 0.37 },
        { strike: 80, iv: 0.3 },
      ],
      calls: [
        { strike: 100, iv: 0.25 },
        { strike: 120, iv: 0.22 },
      ],
    },
  ],
});

async function solvedCoupon(market: MarketData): Promise<number> {
  __clearPathCacheForTests();
  const res = await executePriceRequest(
    {
      id: 't',
      product: spec,
      market,
      mc: { numPaths: 60_000, seed: 42, antithetic: true },
      solve: { kind: 'couponPa' },
      greeks: false,
    },
    hooks,
  );
  expect(res).not.toBeNull();
  return res!.solvedValue!;
}

function withCosts(patch: Partial<CostParams>): MarketData {
  return { ...baseMarket, costs: { fundingSpreadBp: 0, borrowCostBp: 0, feePct: 0, ...patch } };
}

describe('cost layer — direction each term moves the solved coupon', () => {
  beforeEach(() => __clearPathCacheForTests());

  it('a retained fee REDUCES the coupon — the structure only has to be worth reoffer minus fee', async () => {
    const base = await solvedCoupon(baseMarket);
    const withFee = await solvedCoupon(withCosts({ feePct: 1.5 }));
    // Measured about -1.54 coupon points for a 1.5% fee on this 1y note.
    expect(withFee).toBeLessThan(base);
    // This is the dominant reason a bank's quote is less aggressive than a
    // fair value. So the effect must be of fee-like magnitude, not marginal.
    expect(base - withFee).toBeGreaterThan(0.5);
  });

  it('a funding spread RAISES the coupon — the issuer funding benefit', async () => {
    const base = await solvedCoupon(baseMarket);
    const funded = await solvedCoupon(withCosts({ fundingSpreadBp: 100 }));
    // Discounting the note's own cashflows on the issuer curve cheapens the
    // bond component and frees cash for optionality. Measured about +1.00.
    expect(funded).toBeGreaterThan(base);
  });

  it('borrow cost RAISES the coupon, because it is carry and not a desk charge', async () => {
    const base = await solvedCoupon(baseMarket);
    const borrowed = await solvedCoupon(withCosts({ borrowCostBp: 100 }));
    // Borrow lowers the forward. The put the investor is short is worth more.
    // The note is worth less. The coupon must rise. Measured about +0.13.
    // Intuition says "a cost should reduce what is payable" — that would be
    // a fee, not carry. Getting this backwards is easy; hence the test.
    expect(borrowed).toBeGreaterThan(base);
  });

  it('costs default to absent, leaving a pure risk-neutral fair value', async () => {
    const base = await solvedCoupon(baseMarket);
    const explicitZero = await solvedCoupon(withCosts({}));
    expect(explicitZero).toBeCloseTo(base, 9);
  });
});

describe('volatility skew — pricing at the risk strike instead of ATM', () => {
  beforeEach(() => __clearPathCacheForTests());

  it('reports the surface vol and the strike it came from', async () => {
    __clearPathCacheForTests();
    const res = await executePriceRequest(
      {
        id: 't',
        product: spec,
        market: { ...baseMarket, volSurface: skewSurface },
        mc: { numPaths: 20_000, seed: 42, antithetic: true },
        solve: { kind: 'none' },
        greeks: false,
      },
      hooks,
    );
    expect(res!.basis!.volSource).toBe('surface');
    // The 60% knock-in barrier governs the downside. So that is where the
    // surface is read — 37% here, not the 25% ATM vol.
    expect(res!.basis!.riskStrikePct).toBe(60);
    expect(res!.basis!.volUsed).toBeCloseTo(0.37, 12);
    expect(res!.basis!.riskStrikeReason).toMatch(/barrier/i);
  });

  it('falls back to flat vol, and reports it, when no surface is present', async () => {
    __clearPathCacheForTests();
    const res = await executePriceRequest(
      {
        id: 't',
        product: spec,
        market: baseMarket,
        mc: { numPaths: 20_000, seed: 42, antithetic: true },
        solve: { kind: 'none' },
        greeks: false,
      },
      hooks,
    );
    expect(res!.basis!.volSource).toBe('flat');
    expect(res!.basis!.volUsed).toBeCloseTo(0.25, 12);
    expect(res!.basis!.riskStrikePct).toBeUndefined();
  });

  it('a skewed surface RAISES the coupon versus flat ATM vol', async () => {
    const flat = await solvedCoupon(baseMarket);
    const skewed = await solvedCoupon({ ...baseMarket, volSurface: skewSurface });
    // Flat ATM vol underprices a low-barrier knock-in put. That overstates the
    // note's value, and so understates the coupon. Correcting it pushes the
    // coupon UP, measured about +4.7 on this note. Skew makes the model MORE
    // aggressive. So skew is not what explains a bank quoting less.
    expect(skewed).toBeGreaterThan(flat);
  });
});
