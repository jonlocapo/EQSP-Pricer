import { describe, expect, it } from 'vitest';
import { realizedDivYield } from '../src/model/divYield';
import { seriesFromYahooChart, totalReturnIndexFor } from '../src/services/divYieldFetch';

/**
 * The yield is the gap between a total-return series and a price series. These
 * tests build both from a KNOWN yield so the recovered number can be checked
 * exactly, rather than only checking that a number comes out.
 */

const DAYS_PER_YEAR = 252;

/**
 * A price path plus its total-return twin, for a known continuous yield.
 * The price path may drift and wobble however it likes: the yield is defined by
 * the DIFFERENCE in log returns, so it must be recovered whatever the price
 * does. That is the property worth pinning.
 */
function seriesWithYield(n: number, yieldPa: number, seed = 7): { price: number[]; total: number[] } {
  let s = 100;
  let a = seed;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return (a + 0.5) / 4294967296 - 0.5;
  };
  const price: number[] = [];
  const total: number[] = [];
  let cumDiv = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) s *= Math.exp(0.0003 + 0.01 * rnd());
    // The total-return series accrues the dividend on top of the price path.
    if (i > 0) cumDiv += yieldPa / DAYS_PER_YEAR;
    price.push(s);
    total.push(s * Math.exp(cumDiv));
  }
  return { price, total };
}

describe('realizedDivYield', () => {
  it('recovers a known yield regardless of what the price path does', () => {
    for (const y of [0, 0.005, 0.02, 0.045, 0.08]) {
      const { price, total } = seriesWithYield(505, y);
      const r = realizedDivYield(total, price);
      expect(r.divYield).toBeCloseTo(y, 10);
      expect(r.years).toBeCloseTo(504 / DAYS_PER_YEAR, 12);
    }
  });

  it('is unchanged by a violent price move, since only the return GAP matters', () => {
    const { price, total } = seriesWithYield(300, 0.03);
    // Halve the price from the midpoint onward on both series, as a split or a
    // crash would. The gap, and so the yield, must not move.
    const cut = 150;
    const p2 = price.map((v, i) => (i >= cut ? v / 2 : v));
    const t2 = total.map((v, i) => (i >= cut ? v / 2 : v));
    expect(realizedDivYield(t2, p2).divYield).toBeCloseTo(realizedDivYield(total, price).divYield, 10);
  });

  it('drops unusable pairs TOGETHER so the two series stay aligned', () => {
    const { price, total } = seriesWithYield(400, 0.02);
    const p = [...price];
    const t = [...total];
    // A missing bar on one side only. Dropping just that one element would
    // shift every later pair and corrupt the answer.
    p[100] = NaN;
    t[250] = NaN;
    const r = realizedDivYield(t, p);
    expect(r.divYield).toBeGreaterThan(0.015);
    expect(r.divYield).toBeLessThan(0.025);
  });

  it('flattens a slightly negative reading to zero, since dividends cannot be negative', () => {
    const { price, total } = seriesWithYield(300, 0);
    // Nudge the total-return end DOWN a hair, as rounding can.
    const t = [...total];
    t[t.length - 1] *= 0.9995;
    expect(realizedDivYield(t, price).divYield).toBe(0);
  });

  it('rejects rather than accepts an implausible or badly mismatched pair', () => {
    const { price, total } = seriesWithYield(300, 0.02);
    // A yield of 60% means the series do not correspond, not a 60% payer.
    const rich = price.map((v, i) => v * Math.exp((0.6 * i) / DAYS_PER_YEAR));
    expect(() => realizedDivYield(rich, price)).toThrow(/implausible/i);
    // Strongly negative means the same thing with the sign flipped.
    expect(() => realizedDivYield(price, rich)).toThrow(/negative/i);
    expect(() => realizedDivYield(total, price.slice(1))).toThrow(/same length/i);
  });

  it('refuses a window too short to annualize', () => {
    const { price, total } = seriesWithYield(30, 0.02);
    expect(() => realizedDivYield(total, price)).toThrow(/need 60/i);
  });
});

describe('seriesFromYahooChart', () => {
  const withAdj = {
    chart: {
      result: [
        {
          indicators: {
            quote: [{ close: [100, 101, null, 103] }],
            adjclose: [{ adjclose: [99, 100, null, 102] }],
          },
        },
      ],
    },
  };

  it('reads close and adjusted close, keeping length so the two stay aligned', () => {
    const s = seriesFromYahooChart(withAdj);
    expect(s.close).toHaveLength(4);
    expect(s.adjClose).toHaveLength(4);
    expect(Number.isNaN(s.close[2])).toBe(true);
    expect(Number.isNaN(s.adjClose![2])).toBe(true);
  });

  it('reports no adjusted close for a price index, rather than inventing one', () => {
    const indexShape = { chart: { result: [{ indicators: { quote: [{ close: [100, 101] }] } }] } };
    expect(seriesFromYahooChart(indexShape).adjClose).toBeUndefined();
  });

  it('throws a clear message on a malformed response', () => {
    expect(() => seriesFromYahooChart({})).toThrow(/no result/i);
    expect(() => seriesFromYahooChart({ chart: { result: [{}] } })).toThrow(/no close series/i);
    expect(() =>
      seriesFromYahooChart({ chart: { result: [], error: { description: 'No data found' } } }),
    ).toThrow(/No data found/);
  });
});

describe('totalReturnIndexFor', () => {
  it('maps a known price index to its gross-return counterpart', () => {
    expect(totalReturnIndexFor('^GSPC')).toBe('^SP500TR');
    expect(totalReturnIndexFor('^spx')).toBe('^SP500TR');
  });

  it('returns undefined for an index with no known counterpart', () => {
    expect(totalReturnIndexFor('^STOXX50E')).toBeUndefined();
  });
});
