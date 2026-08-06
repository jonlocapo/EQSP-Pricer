import { describe, expect, it } from 'vitest';
import { executePriceRequest, type PricingHooks } from '../src/worker/pricing';
import { __clearPathCacheForTests } from '../src/engine/pathCache';
import { buildRealizedSurface } from '../src/model/realizedSurface';
import { buildSkewSurface, effectiveBeta1y, DEFAULT_BETA_1Y, SINGLE_NAME_SKEW_DAMPING } from '../src/model/skewSurface';
import { volAtPctOfSpot } from '../src/model/volSurface';
import type { MarketData } from '../src/model/market';
import type { CouponProductSpec } from '../src/model/product';

/**
 * The realized rungs of the vol pipeline now take their smile SHAPE from the
 * slope parameterisation in model/skewSurface, and no longer from realized
 * third and fourth moments through a Gram-Charlier expansion.
 *
 * Five tests, each covering a different way the wiring could be wrong:
 * the level could drift, the price could move the wrong way, the index and
 * single-name cases could be confused, the forward could be ignored, or the
 * shape could go somewhere nonsensical. Magnitudes are left to
 * skewSurface's own tests; these pin the WIRING contract.
 */

const SPOT = 100;
const TERMS = [
  { tYears: 0.25, vol: 0.24 },
  { tYears: 1, vol: 0.22 },
  { tYears: 3, vol: 0.2 },
];

const hooks: PricingHooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

/** The shape the realized rungs used to produce, from realized moments. The
 * skew here is deliberately a realistic DAILY sample skewness, which is the
 * point: it is roughly an order of magnitude shallower than what options
 * price. */
const oldRealized = buildRealizedSurface(
  SPOT,
  { terms: TERMS, skewDaily: -0.45, excessKurtDaily: 3 },
  'realized moments',
);

const newSkew = (isIndex = true, rate = 0, divYield = 0) =>
  buildSkewSurface(SPOT, TERMS, effectiveBeta1y(isIndex), rate, divYield, 'slope');

describe('skew wiring', () => {
  it('keeps the level and term structure, and only steepens the shape', () => {
    // The rung computed these vols from Yang-Zhang plus GARCH. Replacing the
    // SHAPE must not disturb the LEVEL, or the whole vol model silently
    // changes meaning. At the money must still be exactly what came in.
    for (const t of TERMS) {
      expect(volAtPctOfSpot(newSkew(), 100, t.tYears)).toBeCloseTo(t.vol, 9);
    }
    // And the wing must be materially steeper than the realized-moment shape
    // it replaces, at every maturity, which is the reason for the change.
    for (const t of TERMS) {
      const wingNew = volAtPctOfSpot(newSkew(), 80, t.tYears) - t.vol;
      const wingOld = volAtPctOfSpot(oldRealized, 80, t.tYears) - volAtPctOfSpot(oldRealized, 100, t.tYears);
      expect(wingNew).toBeGreaterThan(wingOld);
      expect(wingNew).toBeGreaterThan(0);
    }
  });

  it('raises the solved coupon on a barrier note, which is the economic claim', async () => {
    // A steeper downside wing prices the short put higher, so the issuer must
    // pay MORE coupon to bring the note back to the reoffer. If this direction
    // is ever backwards, the surface is making notes look cheaper than they
    // are, which is the failure that matters commercially.
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
    const base: MarketData = { spot: SPOT, vol: 0.22, rate: 0.03, divYield: 0.02, currency: 'EUR' };
    const solve = async (volSurface: MarketData['volSurface']) => {
      __clearPathCacheForTests();
      const res = await executePriceRequest(
        {
          id: 't',
          product: spec,
          market: { ...base, volSurface },
          mc: { numPaths: 40_000, seed: 42, antithetic: true },
          solve: { kind: 'couponPa' },
          greeks: false,
        },
        hooks,
      );
      expect(res).not.toBeNull();
      return res!.solvedValue!;
    };
    const withOld = await solve(oldRealized);
    const withNew = await solve(newSkew());
    expect(withNew).toBeGreaterThan(withOld);
  });

  it('damps a single name relative to an index, by the documented factor', () => {
    // Index skew is steeper because it embeds correlation risk, so applying it
    // undamped to a single stock overstates the wing. The damping has to reach
    // the surface, not merely exist as a constant.
    expect(effectiveBeta1y(false)).toBeCloseTo(DEFAULT_BETA_1Y * SINGLE_NAME_SKEW_DAMPING, 12);
    const wing = (isIndex: boolean) => volAtPctOfSpot(newSkew(isIndex), 80, 1) - 0.22;
    expect(wing(false)).toBeLessThan(wing(true));
    expect(wing(false)).toBeGreaterThan(0);
    expect(wing(false) / wing(true)).toBeCloseTo(SINGLE_NAME_SKEW_DAMPING, 6);
  });

  it('measures moneyness against the FORWARD, so the rate and dividend reach it', () => {
    // This is the plumbing the wiring added: the rung passes its rate and its
    // MEASURED dividend yield through. Log-moneyness is taken against the
    // forward, so a large dividend pulls the forward below spot and the
    // 100%-of-spot strike stops being at the money. If the arguments were
    // dropped the two surfaces below would be identical.
    const flatForward = newSkew(true, 0, 0);
    const bigDividend = newSkew(true, 0.0, 0.08);
    expect(volAtPctOfSpot(bigDividend, 100, 1)).not.toBeCloseTo(volAtPctOfSpot(flatForward, 100, 1), 6);
    // A forward BELOW spot puts the 100%-of-spot strike above the forward, on
    // the low-vol side of the smile.
    expect(volAtPctOfSpot(bigDividend, 100, 1)).toBeLessThan(volAtPctOfSpot(flatForward, 100, 1));
    // A rate that offsets the dividend restores the forward, and with it the level.
    expect(volAtPctOfSpot(newSkew(true, 0.08, 0.08), 100, 1)).toBeCloseTo(
      volAtPctOfSpot(flatForward, 100, 1),
      9,
    );
  });

  it('stays monotone and finite across the strike band and out to long tenors', () => {
    // The shape must never invert, because lower vol at the barrier than at the
    // money would understate the short put and so the coupon. It must also not
    // rely on the clamps inside the band a structured note actually reads.
    for (const t of [0.25, 1, 3, 5, 10]) {
      const s = buildSkewSurface(SPOT, [{ tYears: t, vol: 0.22 }], effectiveBeta1y(true), 0.03, 0.02, 's');
      let previous = Infinity;
      for (const pct of [60, 70, 80, 90, 100, 110, 120, 130, 140]) {
        const v = volAtPctOfSpot(s, pct, t);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(previous);
        previous = v;
      }
    }
    // The wing flattens with maturity, never steepens.
    const wingAt = (t: number) =>
      volAtPctOfSpot(buildSkewSurface(SPOT, [{ tYears: t, vol: 0.22 }], effectiveBeta1y(true), 0, 0, 's'), 80, t) -
      0.22;
    expect(wingAt(0.25)).toBeGreaterThan(wingAt(1));
    expect(wingAt(1)).toBeGreaterThan(wingAt(5));
  });
});
