import { describe, expect, it } from 'vitest';
import { barsFromYahooChart } from '../src/services/ohlcFetch';

/** Pure parser tests -- no network. Mirrors the shape of
 * tests/marketFetch.test.ts's closesFromYahooChart coverage. */

function chartJson(quote: {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
}) {
  return { chart: { result: [{ indicators: { quote: [quote] } }] } };
}

describe('barsFromYahooChart', () => {
  it('parses a clean OHLC series', () => {
    const json = chartJson({
      open: [100, 101, 102],
      high: [101, 102, 103],
      low: [99, 100, 101],
      close: [100.5, 101.5, 102.5],
    });
    const bars = barsFromYahooChart(json);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toEqual({ open: 100, high: 101, low: 99, close: 100.5 });
  });

  it('drops a bar entirely when any one field is null or missing', () => {
    const json = chartJson({
      open: [100, null, 102],
      high: [101, 102, 103],
      low: [99, 100, 101],
      close: [100.5, 101.5, 102.5],
    });
    const bars = barsFromYahooChart(json);
    expect(bars).toHaveLength(2);
  });

  it('drops a bar with a non-positive field', () => {
    const json = chartJson({
      open: [100, -5, 102],
      high: [101, 102, 103],
      low: [99, 100, 101],
      close: [100.5, 101.5, 102.5],
    });
    const bars = barsFromYahooChart(json);
    expect(bars).toHaveLength(2);
  });

  it('throws when the response has no result', () => {
    expect(() => barsFromYahooChart({ chart: { result: [], error: { description: 'No data found' } } })).toThrow(
      /No data found/,
    );
  });

  it('throws when the response has no quote series', () => {
    expect(() => barsFromYahooChart({ chart: { result: [{ indicators: {} }] } })).toThrow(/no OHLC series/i);
  });
});
