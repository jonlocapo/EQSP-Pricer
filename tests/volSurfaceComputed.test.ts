import { describe, expect, it } from 'vitest';
import { bsCall, bsPut } from '../src/engine/blackScholes';
import { buildVolSurface, volAtPctOfSpot } from '../src/model/volSurface';

const spot = 100;
const rate = 0.03;
const divYield = 0.01;
const tYears = 1;

/** True (unknown-to-the-test-subject) vol at each strike: a normal equity
 * skew, matching the fixture other tests already use for comparability. */
const TRUE_VOL: Record<number, number> = { 60: 0.36, 80: 0.3, 95: 0.26, 100: 0.25, 120: 0.22 };

/**
 * A chain whose bid/ask genuinely reflect TRUE_VOL, but whose `iv` field is
 * deliberately WRONG on every quote — the marketdata.app defect this whole
 * change exists to stop trusting. `buildVolSurface({ rate, divYield })`
 * must recover TRUE_VOL from the prices and ignore the poisoned `iv`.
 */
function chainWithWrongProviderIv() {
  const priceAt = (strike: number, isCall: boolean) =>
    isCall
      ? bsCall(spot, strike, tYears, TRUE_VOL[strike], rate, divYield)
      : bsPut(spot, strike, tYears, TRUE_VOL[strike], rate, divYield);

  const quote = (strike: number, isCall: boolean) => {
    const mid = priceAt(strike, isCall);
    // A tight, realistic spread: +/- 0.5% of the price, plus a floor so a
    // very cheap option still has a nonzero (but tiny) spread.
    const halfSpread = Math.max(0.001, mid * 0.005);
    return { strike, bid: mid - halfSpread, ask: mid + halfSpread, iv: 0.0001 };
  };

  return {
    spot,
    source: 'test',
    slices: [
      {
        tYears,
        puts: [quote(60, false), quote(80, false), quote(95, false)],
        calls: [quote(100, true), quote(120, true)],
      },
    ],
  };
}

describe('buildVolSurface with opts — inverts PRICES instead of trusting provider iv', () => {
  it('recovers the true vol at every strike even though every provider iv is poisoned at 0.0001', () => {
    const chain = chainWithWrongProviderIv();
    const surface = buildVolSurface(chain, { rate, divYield });

    for (const strike of [60, 80, 95, 100, 120]) {
      const got = volAtPctOfSpot(surface, strike, tYears);
      // A tight bid/ask (0.5% of price) supports vol recovery well within a
      // vol point of the true level — nowhere near the poisoned 0.0001.
      expect(Math.abs(got - TRUE_VOL[strike])).toBeLessThan(0.01);
      expect(got).toBeGreaterThan(0.05); // sanity: nowhere near the poisoned provider iv
    }
  });

  it('without opts, the poisoned provider iv breaks the surface entirely — this is the bug being fixed', () => {
    const chain = chainWithWrongProviderIv();
    // Every quote's iv is 0.0001, below MIN_IV (0.005), so the old,
    // provider-trusting path finds no usable vol ANYWHERE in the chain and
    // throws outright — silently trusting the provider was not just
    // imprecise, it was a total failure for this chain. `opts` fixes this
    // by never looking at the poisoned field in the first place.
    expect(() => buildVolSurface(chain)).toThrow(/no usable implied vols/i);
  });

  it('a wide-spread quote is dropped rather than accepted at a meaningless mid', () => {
    const trueVol = 0.3;
    const strike = 70;
    const mid = bsPut(spot, strike, tYears, trueVol, rate, divYield);
    const chain = {
      spot,
      source: 'test',
      slices: [
        {
          tYears,
          puts: [
            // Spread so wide relative to vega that the vol uncertainty
            // blows past MAX_VOL_UNCERTAINTY. No `iv` and no `last` either,
            // so there is nothing else for this quote to fall back to.
            { strike, bid: Math.max(0.001, mid - 5), ask: mid + 5 },
          ],
          calls: [],
        },
      ],
    };
    expect(() => buildVolSurface(chain, { rate, divYield })).toThrow(/no usable implied vols/i);
  });

  it('falls back to the provider iv for one quote while computing another from price in the same slice', () => {
    const trueVol = 0.28;
    const strike = 90;
    const mid = bsPut(spot, strike, tYears, trueVol, rate, divYield);
    const chain = {
      spot,
      source: 'test',
      slices: [
        {
          tYears,
          puts: [
            // No price at all (no bid/ask/last) — must fall back to iv.
            { strike: 60, iv: 0.4 },
            // Normal, tight, price-backed quote.
            { strike, bid: mid - 0.01, ask: mid + 0.01 },
          ],
          calls: [],
        },
      ],
    };
    const surface = buildVolSurface(chain, { rate, divYield });
    expect(volAtPctOfSpot(surface, 60, tYears)).toBeCloseTo(0.4, 6);
    expect(Math.abs(volAtPctOfSpot(surface, strike, tYears) - trueVol)).toBeLessThan(0.005);
  });
});
