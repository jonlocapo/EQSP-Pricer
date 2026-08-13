import { describe, expect, it } from 'vitest';
import { computeCacheKey, gridTimesDigest } from '../src/engine/pathCache';
import { buildGrid } from '../src/engine/schedule';
import { DEFAULT_COUPON_SPEC } from '../src/state/tradeStore';
import type { BasketAsset, LegQuantoParams, MarketData } from '../src/model/market';

/**
 * B2 of the worst-of prerequisites: the path-cache key must cover EVERYTHING
 * path generation depends on.
 *
 * The danger: two different pricing environments can agree on the few single
 * numbers the key happens to record, and the cache then hands the second
 * environment the FIRST environment's paths — a confident, wrong price with
 * nothing in the log. This test enumerates every market input that changes a
 * path and asserts each one changes the key. Today that list is the single
 * underlying's inputs; when per-asset spots/vols/dividends and the correlation
 * matrix arrive, the same test fails until they are added to the key too.
 *
 * Fields that do NOT affect path generation are deliberately absent from the
 * list: currency (display/quanto-seeding only), funding spread and fee (move
 * discounting and valuation, which the path cache does not own), and
 * volSurface (its effect arrives as the derived `vol`/`volPerStep`, which are
 * keyed).
 */

const BASE: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

function keyFor(m: MarketData): string {
  const grid = buildGrid({ ...DEFAULT_COUPON_SPEC, callType: 'none' as const, barrierType: 'european' as const });
  return computeCacheKey({
    s0: m.spot,
    market: m,
    numPaths: 1000,
    seed: 7,
    antithetic: true,
    nSteps: grid.nSteps,
    timesKey: gridTimesDigest(grid),
  });
}

const LEG_QUANTO: LegQuantoParams = { currency: 'USD', rateUnderlying: 0.043, fxVol: 0.08, corrEqFx: 0.25 };

/** A two-leg basket whose SECOND leg carries `patch`. Leg 1 stays at the
 * scalar market's own numbers, so each mutation below differs from the base
 * basket in exactly one field. */
function basketWith(patch: Partial<BasketAsset> = {}): MarketData {
  return {
    ...BASE,
    basket: {
      assets: [
        { vol: 0.25, divYield: 0.02 },
        { vol: 0.28, divYield: 0.015, ...patch },
      ],
      correlation: [
        [1, 0.5],
        [0.5, 1],
      ],
    },
  };
}

const MUTATIONS: [string, MarketData][] = [
  ['spot', { ...BASE, spot: 101 }],
  ['vol', { ...BASE, vol: 0.26 }],
  ['rate', { ...BASE, rate: 0.03 }],
  ['divYield', { ...BASE, divYield: 0.03 }],
  ['rateCurve', { ...BASE, rateCurve: [{ tYears: 1, rate: 0.03 }] }],
  ['volPerStep', { ...BASE, volPerStep: [0.25] }],
  ['costs.borrowCostBp', { ...BASE, costs: { fundingSpreadBp: 0, borrowCostBp: 100, feePct: 0 } }],
  ['quanto (present)', { ...BASE, quanto: { rateUnderlying: 0.03, fxVol: 0.1, corrEqFx: 0.2 } }],
  ['quanto.rateUnderlying', { ...BASE, quanto: { rateUnderlying: 0.04, fxVol: 0.1, corrEqFx: 0.2 } }],
  ['quanto.fxVol', { ...BASE, quanto: { rateUnderlying: 0.03, fxVol: 0.11, corrEqFx: 0.2 } }],
  ['quanto.corrEqFx', { ...BASE, quanto: { rateUnderlying: 0.03, fxVol: 0.1, corrEqFx: 0.3 } }],
  ['basket (present)', basketWith()],
  ['basket leg vol', basketWith({ vol: 0.29 })],
  ['basket leg divYield', basketWith({ divYield: 0.02 })],
  // Every per-leg quanto field enters that leg's drift, so each one changes
  // every path of that leg. A missing field here is the borrow-cost bug again:
  // the cache stays warm and replays the previous currency's paths.
  ['basket leg quanto (present)', basketWith({ quanto: LEG_QUANTO })],
  ['basket leg quanto.currency', basketWith({ quanto: { ...LEG_QUANTO, currency: 'CHF' } })],
  ['basket leg quanto.rateUnderlying', basketWith({ quanto: { ...LEG_QUANTO, rateUnderlying: 0.05 } })],
  ['basket leg quanto.fxVol', basketWith({ quanto: { ...LEG_QUANTO, fxVol: 0.09 } })],
  ['basket leg quanto.corrEqFx', basketWith({ quanto: { ...LEG_QUANTO, corrEqFx: -0.4 } })],
];

describe('B2: the path-cache key covers every path-affecting market input', () => {
  it('changing any single input changes the key', () => {
    const baseKey = keyFor(BASE);
    for (const [name, m] of MUTATIONS) {
      expect(keyFor(m), `changing ${name} must change the cache key`).not.toBe(baseKey);
    }
  });

  it('every basket mutation also differs from the plain basket, not only from the scalar base', () => {
    // Comparing against the scalar BASE alone would pass even if the key
    // ignored every per-leg field, because merely HAVING a basket changes the
    // key. Each per-leg mutation must differ from the unmutated basket too,
    // and from every other mutation.
    const keys = new Map<string, string>([['basket (plain)', keyFor(basketWith())]]);
    for (const [name, m] of MUTATIONS.filter(([n]) => n.startsWith('basket leg'))) {
      const key = keyFor(m);
      for (const [other, otherKey] of keys) {
        expect(key, `${name} must not collide with ${other}`).not.toBe(otherKey);
      }
      keys.set(name, key);
    }
  });

  it('changing nothing keeps the key stable, and a second identical key equals the first', () => {
    const a = keyFor(BASE);
    const b = keyFor({ ...BASE });
    expect(b).toBe(a);
  });

  it('inputs that do not affect paths do not need to be in the key', () => {
    // Documenting the deliberate absence: currency, funding spread and fee do
    // not move paths, so keying on them would evict the cache for no gain.
    // The assertions pin that they are equal, so nobody "fixes" the key by
    // adding them.
    expect(keyFor({ ...BASE, currency: 'USD' })).toBe(keyFor(BASE));
    expect(keyFor({ ...BASE, costs: { fundingSpreadBp: 50, borrowCostBp: 0, feePct: 1 } })).toBe(keyFor(BASE));
  });
});
