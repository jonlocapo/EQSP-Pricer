import { describe, expect, it } from 'vitest';
import { buildBasket, resizeCorrelation, removeFromCorrelation } from '../src/model/basket';
import { isPsd } from '../src/model/correlation';
import { validateBasket } from '../src/services/validation';
import { realizedCorrelation, type DatedClose } from '../src/services/marketFetch';
import { NO_COSTS, type LegQuantoParams, type MarketData } from '../src/model/market';

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

describe('buildBasket', () => {
  it('assembles a 2-leg basket in spec order, and leaves 1 leg without a basket', () => {
    const legs = [
      { name: 'SX5E', vol: 0.2, divYield: 0.03 },
      { name: 'SPX', vol: 0.18, divYield: 0.015 },
    ];
    const two = buildBasket(legs, [[1, 0.5], [0.5, 1]]);
    expect(two.underlyings).toEqual([{ name: 'SX5E' }, { name: 'SPX' }]);
    expect(two.basket).toBeDefined();
    expect(two.basket!.assets).toEqual([{ vol: 0.2, divYield: 0.03 }, { vol: 0.18, divYield: 0.015 }]);
    expect(two.basket!.correlation[0][1]).toBeCloseTo(0.5, 6);
    expect(two.correlationAdjusted).toBe(false);

    const one = buildBasket([legs[0]], [[1]]);
    expect(one.basket).toBeUndefined();
    expect(one.underlyings).toEqual([{ name: 'SX5E' }]);
  });

  it('repairs a jointly-impossible 3-leg correlation triple to a valid PSD matrix, and flags the adjustment', () => {
    const legs = [
      { name: 'A', vol: 0.2, divYield: 0 },
      { name: 'B', vol: 0.2, divYield: 0 },
      { name: 'C', vol: 0.2, divYield: 0 },
    ];
    // Each pair is individually legal (|corr| <= 1), but jointly impossible:
    // the same known-bad matrix pinned in correlationRepair.test.ts.
    const bad = [
      [1, -0.7, -0.7],
      [-0.7, 1, -0.7],
      [-0.7, -0.7, 1],
    ];
    const result = buildBasket(legs, bad);
    expect(result.basket).toBeDefined();
    expect(isPsd(result.basket!.correlation)).toBe(true);
    expect(result.correlationAdjusted).toBe(true);
  });
});

describe('resizeCorrelation / removeFromCorrelation', () => {
  it('grows preserving existing entries, and shrinks by dropping exactly one leg', () => {
    const grown = resizeCorrelation([[1, 0.4], [0.4, 1]], 3);
    expect(grown).toEqual([
      [1, 0.4, 0],
      [0.4, 1, 0],
      [0, 0, 1],
    ]);

    const full = [
      [1, 0.4, 0.2],
      [0.4, 1, 0.3],
      [0.2, 0.3, 1],
    ];
    // Removing leg index 1 (the middle leg) must leave the 0-2 pair intact,
    // not renumber or shift any other pairwise entry.
    const shrunk = removeFromCorrelation(full, 1);
    expect(shrunk).toEqual([
      [1, 0.2],
      [0.2, 1],
    ]);
  });
});

describe('validateBasket', () => {
  it('is a no-op for a single leg, and enforces every rule at 2+ legs', () => {
    expect(validateBasket([{ name: 'SX5E' }], [[1]], market).valid).toBe(true);

    const dup = validateBasket([{ name: 'SX5E' }, { name: 'sx5e' }], [[1, 0], [0, 1]], market);
    expect(dup.valid).toBe(false);
    expect(dup.errors.underlying1).toMatch(/Duplicate/);

    const empty = validateBasket([{ name: 'SX5E' }, { name: '  ' }], [[1, 0], [0, 1]], market);
    expect(empty.errors.underlying1).toMatch(/required/);

    const outOfRange = validateBasket([{ name: 'A' }, { name: 'B' }], [[1, 1.5], [1.5, 1]], market);
    expect(outOfRange.errors.correlation).toMatch(/between -1 and 1/);

    // `market.quanto` on a basket is no longer a clash. It describes the
    // PRIMARY leg of a multi-currency worst-of, and the engine prices that
    // leg with its own quanto drift (see model/market.ts's `legQuantoOf`).
    // Neither leg here reports a currency, so there is nothing to flag.
    const quantoMarket: MarketData = { ...market, quanto: { rateUnderlying: 0.01, fxVol: 0.1, corrEqFx: 0 } };
    const quantoOk = validateBasket([{ name: 'A' }, { name: 'B' }], [[1, 0.2], [0.2, 1]], quantoMarket);
    expect(quantoOk.valid).toBe(true);

    // Costs on their own do not interact with the basket rules at all.
    const withCosts = validateBasket([{ name: 'A' }, { name: 'B' }], [[1, 0.2], [0.2, 1]], {
      ...market,
      costs: NO_COSTS,
    });
    expect(withCosts.valid).toBe(true);
  });

  it('flags a foreign leg with no quanto inputs, and accepts the same leg once it has them', () => {
    // The note is EUR (see `market` above). A USD leg is allowed now — it
    // prices as a quanto leg — but only when it carries the three inputs its
    // drift needs. Without them the leg would drift at the EUR rate with no
    // FX correction, which is the silent misprice the old single-currency
    // rule existed to stop.
    const legs = [
      { name: 'Rheinmetall AG', ticker: 'RHM.DE', currency: 'EUR' },
      { name: 'Lockheed Martin', ticker: 'LMT', currency: 'USD' },
    ];
    const corr = [[1, 0.2], [0.2, 1]];
    const mismatch = validateBasket(legs, corr, market);
    expect(mismatch.valid).toBe(false);
    expect(mismatch.errors.currency1).toMatch(/LMT.*USD.*EUR/);

    // The same basket, with leg 2's quanto inputs present, prices.
    const usdLeg: LegQuantoParams = { currency: 'USD', rateUnderlying: 0.043, fxVol: 0.08, corrEqFx: -0.25 };
    const multiCcy: MarketData = {
      ...market,
      basket: {
        assets: [
          { vol: 0.25, divYield: 0.02 },
          { vol: 0.28, divYield: 0.015, quanto: usdLeg },
        ],
        correlation: corr,
      },
    };
    expect(validateBasket(legs, corr, multiCcy).valid).toBe(true);

    // Inputs measured against the WRONG currency are refused: they describe a
    // different FX rate, so they would price the leg on the wrong forward.
    const staleCcy: MarketData = {
      ...multiCcy,
      basket: {
        assets: [
          { vol: 0.25, divYield: 0.02 },
          { vol: 0.28, divYield: 0.015, quanto: { ...usdLeg, currency: 'CHF' } },
        ],
        correlation: corr,
      },
    };
    expect(validateBasket(legs, corr, staleCcy).errors.currency1).toMatch(/CHF/);

    // A zero FX vol is not a neutral default: it prices the quanto leg as
    // though the two currencies never moved apart.
    const zeroFxVol: MarketData = {
      ...multiCcy,
      basket: {
        assets: [
          { vol: 0.25, divYield: 0.02 },
          { vol: 0.28, divYield: 0.015, quanto: { ...usdLeg, fxVol: 0 } },
        ],
        correlation: corr,
      },
    };
    expect(zeroFxVol.basket).toBeDefined();
    expect(validateBasket(legs, corr, zeroFxVol).errors.currency1).toMatch(/FX vol/);

    // A leg back in the note currency must not keep its quanto inputs.
    const eurLegs = [legs[0], { ...legs[1], currency: 'EUR' }];
    expect(validateBasket(eurLegs, corr, multiCcy).errors.currency1).toMatch(/still carries quanto inputs/);

    // Same-currency legs pass, and an unfetched leg (no currency yet) is
    // not a mismatch — it simply has nothing to compare yet.
    const ok = validateBasket(
      [
        { name: 'Rheinmetall AG', ticker: 'RHM.DE', currency: 'EUR' },
        { name: 'Leonardo DRS, Inc.', ticker: 'DRS' },
      ],
      [[1, 0.2], [0.2, 1]],
      market,
    );
    expect(ok.valid).toBe(true);
  });
});

describe('realizedCorrelation on misaligned calendars', () => {
  it('drops a bar missing from one side without shifting later dates out of alignment', () => {
    const DAY = 86400;
    const t0 = 1_700_000_000;
    const N = 40;
    // Series A trades every day. Series B is missing day 20 (a local
    // holiday), so it has one fewer bar, and every date after it is offset
    // by one array index relative to A.
    const a: DatedClose[] = Array.from({ length: N }, (_, i) => ({
      t: t0 + i * DAY,
      close: 100 * (1 + 0.001 * i),
    }));
    const b: DatedClose[] = a
      .filter((_, i) => i !== 20)
      .map((d) => ({ t: d.t, close: 200 - 0.05 * ((d.t - t0) / DAY) }));

    // A trends up, B trends down: date-for-date they are perfectly
    // anti-correlated once day 20 is dropped from A too. If the missing bar
    // instead shifted B's later dates into alignment with A's wrong index,
    // the close-index pairing would break and the correlation would not be
    // a clean -1.
    expect(realizedCorrelation(a, b)).toBeLessThan(-0.99);
  });
});
