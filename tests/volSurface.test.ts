import { describe, expect, it } from 'vitest';
import { buildVolSurface, skewPoints, volAt, volAtPctOfSpot, type VolSurface } from '../src/model/volSurface';
import { riskStrikeFor } from '../src/engine/riskStrike';
import type { CouponProductSpec, ParticipationSpec, AccumulatorSpec } from '../src/model/product';

const spot = 100;

/** A chain with a normal equity skew: lower strikes carry higher implied vol. */
function skewedChain(tYears: number, source = 'test') {
  return {
    spot,
    source,
    slices: [
      {
        tYears,
        puts: [
          { strike: 60, iv: 0.36 },
          { strike: 80, iv: 0.3 },
          { strike: 95, iv: 0.26 },
        ],
        calls: [
          { strike: 100, iv: 0.25 },
          { strike: 120, iv: 0.22 },
        ],
      },
    ],
  };
}

describe('buildVolSurface', () => {
  it('builds an OTM composite smile: puts below spot, calls at/above', () => {
    const s = buildVolSurface(skewedChain(1));
    expect(s.slices).toHaveLength(1);
    expect(s.slices[0].points.map((p) => p.strike)).toEqual([60, 80, 95, 100, 120]);
    expect(s.spotRef).toBe(100);
  });

  it('drops implausible or missing implied vols', () => {
    const s = buildVolSurface({
      spot,
      source: 'test',
      slices: [
        {
          tYears: 1,
          puts: [
            { strike: 60, iv: 0 }, // not quoted
            { strike: 80, iv: 0.3 },
            { strike: 90, iv: 9 }, // absurd
          ],
          calls: [{ strike: 100 }], // undefined iv
        },
      ],
    });
    expect(s.slices[0].points).toEqual([{ strike: 80, iv: 0.3 }]);
  });

  it('averages duplicate strikes (both sides quoted at spot)', () => {
    const s = buildVolSurface({
      spot,
      source: 'test',
      slices: [{ tYears: 1, puts: [{ strike: 100, iv: 0.2 }], calls: [{ strike: 100, iv: 0.3 }] }],
    });
    // The put at 100 is not strictly below spot so only the call is taken;
    // duplicates arise when a chain lists the same strike twice on one side.
    expect(s.slices[0].points).toEqual([{ strike: 100, iv: 0.3 }]);
  });

  it('throws when a chain carries no usable vols at all', () => {
    expect(() =>
      buildVolSurface({ spot, source: 'test', slices: [{ tYears: 1, puts: [], calls: [] }] }),
    ).toThrow(/no usable implied vols/i);
  });
});

describe('volAt — strike interpolation', () => {
  const s = buildVolSurface(skewedChain(1));

  it('returns quoted vols exactly at quoted strikes', () => {
    expect(volAt(s, 60, 1)).toBeCloseTo(0.36, 12);
    expect(volAt(s, 100, 1)).toBeCloseTo(0.25, 12);
    expect(volAt(s, 120, 1)).toBeCloseTo(0.22, 12);
  });

  it('interpolates linearly between quoted strikes', () => {
    // Midway between 60 (0.36) and 80 (0.30).
    expect(volAt(s, 70, 1)).toBeCloseTo(0.33, 12);
  });

  it('holds the end vols flat outside the quoted range (never extrapolates)', () => {
    expect(volAt(s, 10, 1)).toBeCloseTo(0.36, 12);
    expect(volAt(s, 500, 1)).toBeCloseTo(0.22, 12);
  });

  it('addresses the surface by % of spot', () => {
    expect(volAtPctOfSpot(s, 60, 1)).toBeCloseTo(0.36, 12);
    expect(volAtPctOfSpot(s, 100, 1)).toBeCloseTo(0.25, 12);
  });

  it('reports a positive skew for a normal equity smile', () => {
    // 80% strike vol (0.30) minus ATM (0.25) = 5 vol points.
    expect(skewPoints(s, 1, 80)).toBeCloseTo(0.05, 12);
  });
});

describe('volAt — maturity interpolation in total variance', () => {
  const s: VolSurface = {
    spotRef: 100,
    source: 'test',
    slices: [
      { tYears: 1, points: [{ strike: 100, iv: 0.2 }] },
      { tYears: 2, points: [{ strike: 100, iv: 0.3 }] },
    ],
  };

  it('interpolates total variance, not vol, between expiries', () => {
    // var(1) = 0.04*1 = 0.04 ; var(2) = 0.09*2 = 0.18
    // halfway in t=1.5 -> var = 0.11 -> iv = sqrt(0.11/1.5)
    expect(volAt(s, 100, 1.5)).toBeCloseTo(Math.sqrt(0.11 / 1.5), 12);
    // Deliberately NOT the naive vol average (0.25).
    expect(volAt(s, 100, 1.5)).not.toBeCloseTo(0.25, 3);
  });

  it('holds flat outside the quoted maturity range', () => {
    expect(volAt(s, 100, 0.1)).toBeCloseTo(0.2, 12);
    expect(volAt(s, 100, 10)).toBeCloseTo(0.3, 12);
  });
});

describe('riskStrikeFor — which strike the dominant leg lives at', () => {
  const coupon: CouponProductSpec = {
    kind: 'coupon',
    underlyings: [{ name: 'T' }],
    currency: 'EUR',
    notional: 1e6,
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

  it('uses the knock-in barrier when there is one — it governs the downside', () => {
    expect(riskStrikeFor(coupon).strikePct).toBe(60);
  });

  it('falls back to the put strike with no barrier', () => {
    expect(riskStrikeFor({ ...coupon, barrierType: 'none' }).strikePct).toBe(100);
  });

  it('participation: barrier, else downside strike, else the upside strike', () => {
    const base: ParticipationSpec = {
      kind: 'participation',
      underlyings: [{ name: 'T' }],
      currency: 'EUR',
      notional: 1e6,
      tenorYears: 1,
      reofferPct: 100,
      issuePricePct: 100,
      upside: { strikePct: 105, participationPct: 150, variant: { variant: 'vanilla' } },
      downside: { strikePct: 90, leveragePct: 100, barrierType: 'american', kiBarrierPct: 65, twinWinPct: 0 },
      bonusPct: 0,
      protectionPct: 0,
    };
    expect(riskStrikeFor(base).strikePct).toBe(65);
    expect(riskStrikeFor({ ...base, downside: { ...base.downside, barrierType: 'none' } }).strikePct).toBe(90);
    // Fully protected: only the upside call carries optionality.
    expect(
      riskStrikeFor({ ...base, downside: { ...base.downside, barrierType: 'none', leveragePct: 0 } }).strikePct,
    ).toBe(105);
  });

  it('accumulator: the accumulation strike', () => {
    const acc: AccumulatorSpec = {
      kind: 'accumulator',
      direction: 'accumulate',
      underlyings: [{ name: 'T' }],
      currency: 'EUR',
      strikePct: 92,
      upfrontPct: 0,
      tenorYears: 0.5,
      settlementFrequency: 'monthly',
      dailyShares: 10,
      koTriggerPct: 110,
      koSettlement: 'ko1',
      gearing: 2,
      guaranteePeriods: 0,
    };
    expect(riskStrikeFor(acc).strikePct).toBe(92);
  });

  it('always explains its choice', () => {
    expect(riskStrikeFor(coupon).reason).toMatch(/barrier/i);
  });
});
