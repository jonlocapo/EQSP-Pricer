import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchVolIndexLevel, volIndexSymbolFor } from '../src/services/volIndex';

/**
 * `volIndexSymbolFor` is pure — tested directly. `fetchVolIndexLevel` talks
 * to the network in production, but here `fetch` is stubbed with a
 * synthetic Yahoo chart-endpoint payload, so the points-to-decimal
 * conversion is pinned without any live call.
 */

describe('volIndexSymbolFor', () => {
  it('maps the documented underlyings to their listed vol index', () => {
    expect(volIndexSymbolFor('^GSPC')).toBe('^VIX');
    expect(volIndexSymbolFor('^SPX')).toBe('^VIX');
    expect(volIndexSymbolFor('SPY')).toBe('^VIX');
    expect(volIndexSymbolFor('^STOXX50E')).toBe('^V2TX');
    expect(volIndexSymbolFor('^GDAXI')).toBe('^VDAX');
    expect(volIndexSymbolFor('^NDX')).toBe('^VXN');
    expect(volIndexSymbolFor('^IXIC')).toBe('^VXN');
    expect(volIndexSymbolFor('QQQ')).toBe('^VXN');
    expect(volIndexSymbolFor('^RUT')).toBe('^RVX');
    expect(volIndexSymbolFor('IWM')).toBe('^RVX');
    expect(volIndexSymbolFor('^FTSE')).toBe('^VFTSE');
  });

  it('returns undefined for an underlying with no listed vol index', () => {
    expect(volIndexSymbolFor('BMW.DE')).toBeUndefined();
    expect(volIndexSymbolFor('AAPL')).toBeUndefined();
    expect(volIndexSymbolFor('')).toBeUndefined();
  });

  it('is tolerant of stray whitespace, and case for a lowercase ticker', () => {
    expect(volIndexSymbolFor(' spy ')).toBe('^VIX');
    expect(volIndexSymbolFor('qqq')).toBe('^VXN');
  });
});

function yahooChartJson(closes: number[], timestamps: number[]): unknown {
  return {
    chart: {
      result: [
        {
          timestamp: timestamps,
          indicators: { quote: [{ close: closes }] },
        },
      ],
    },
  };
}

describe('fetchVolIndexLevel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('divides the printed index points by 100 to get a decimal vol', async () => {
    const body = yahooChartJson([17.5, 17.92], [1700000000, 1700086400]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) }),
    );

    const r = await fetchVolIndexLevel('^VIX');
    expect(r.symbol).toBe('^VIX');
    expect(r.vol).toBeCloseTo(0.1792, 10);
    expect(r.source).toContain('^VIX');
    expect(r.asOf).toBe(new Date(1700086400 * 1000).toISOString());
  });

  it('takes the LAST bar in the series, not the first', async () => {
    const body = yahooChartJson([28.0, 28.39, 27.5], [1, 2, 3]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) }),
    );
    const r = await fetchVolIndexLevel('^VXN');
    expect(r.vol).toBeCloseTo(0.275, 10);
  });

  it('rejects an empty series rather than returning a bogus level', async () => {
    const body = yahooChartJson([], []);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) }),
    );
    await expect(fetchVolIndexLevel('^VIX')).rejects.toThrow();
  });

  it('rejects a blank symbol without attempting a fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchVolIndexLevel('  ')).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
