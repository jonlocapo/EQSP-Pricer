import { describe, expect, it } from 'vitest';
import {
  annualizedVolFromCloses,
  closesFromYahooChart,
  closesWithDatesFromYahooChart,
  fetchFxRealizedVolAndCorr,
  fetchHistVol,
  fetchRefRate,
  realizedCorrelation,
} from '../src/services/marketFetch';
import { fetchImpliedFromOptions } from '../src/services/impliedFetch';
import { toCboeSymbol, toStooqSymbol } from '../src/services/symbols';

// Live-network tests: skipped unless LIVE=1 (not suitable for CI).
// Run with: LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run tests/marketFetch.test.ts
const live = process.env.LIVE === '1' ? describe : describe.skip;

live('marketFetch (live network)', () => {
  it('fetches €STR for EUR', async () => {
    const r = await fetchRefRate('EUR');
    expect(r.rate).toBeGreaterThan(-0.02);
    expect(r.rate).toBeLessThan(0.1);
    expect(r.source).toContain('€STR');
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('fetches SOFR for USD', async () => {
    const r = await fetchRefRate('USD');
    expect(r.rate).toBeGreaterThan(0);
    expect(r.rate).toBeLessThan(0.15);
    expect(r.source).toContain('SOFR');
  });

  it('rejects unsupported currencies with a friendly message', async () => {
    await expect(fetchRefRate('JPY')).rejects.toThrow(/manually/);
  });

  it('estimates 1Y historical vol for AAPL', async () => {
    const r = await fetchHistVol('AAPL');
    expect(r.vol).toBeGreaterThan(0.05);
    expect(r.vol).toBeLessThan(1.5);
    expect(r.days).toBeGreaterThan(100);
    expect(r.source).toMatch(/yahoo|stooq/);
  });

  it('implies dividend yield and ATM vol from SPX options (European parity)', async () => {
    const r = await fetchImpliedFromOptions('^SPX', 1, 0.036);
    expect(r.divYield).toBeGreaterThan(-0.01);
    expect(r.divYield).toBeLessThan(0.06);
    expect(r.atmVol).toBeGreaterThan(0.05);
    expect(r.atmVol).toBeLessThan(0.8);
    expect(r.spot).toBeGreaterThan(1000);
    expect(r.approximate).toBe(false);
  });

  it('implies from AAPL options (flagged approximate)', async () => {
    const r = await fetchImpliedFromOptions('AAPL', 1, 0.036);
    expect(r.divYield).toBeGreaterThan(-0.05);
    expect(r.divYield).toBeLessThan(0.2);
    expect(r.approximate).toBe(true);
  });

  it('fails loudly for unknown tickers', async () => {
    await expect(fetchImpliedFromOptions('ZZZZQQ', 1, 0.03)).rejects.toThrow(/no option chain|blocked/i);
  });

  it('fetches realized FX vol and eq-FX correlation for a USD underlying / EUR note', async () => {
    // USD underlying, EUR note -> Yahoo symbol USDEUR=X (EUR per USD).
    const r = await fetchFxRealizedVolAndCorr('USD', 'EUR', 'AAPL');
    expect(r.fxVol).toBeGreaterThan(0.02);
    expect(r.fxVol).toBeLessThan(0.4);
    expect(r.corrEqFx).toBeGreaterThanOrEqual(-1);
    expect(r.corrEqFx).toBeLessThanOrEqual(1);
    expect(r.days).toBeGreaterThan(100);
    expect(r.source).toContain('yahoo');
  });
});

// Always-on tests: no network required.
describe('marketFetch (offline)', () => {
  it('throws for currencies without an open source', async () => {
    await expect(fetchRefRate('CHF')).rejects.toThrow(/enter the rate manually/);
  });

  it('computes annualized vol from synthetic closes', () => {
    // GBM path with known sigma=20%: sampled vol should land near 0.20.
    const sigma = 0.2;
    const dt = 1 / 252;
    let s = 100;
    const closes = [s];
    let seed = 123456789;
    const rand = () => {
      // Park-Miller
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 252; i++) {
      const u1 = rand();
      const u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      s *= Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z);
      closes.push(s);
    }
    const { vol, days } = annualizedVolFromCloses(closes);
    expect(days).toBe(252);
    // stderr of vol estimate ~ sigma/sqrt(2n) ≈ 0.9%; allow 4x.
    expect(Math.abs(vol - sigma)).toBeLessThan(0.04);
  });

  it('rejects series that are too short', () => {
    expect(() => annualizedVolFromCloses([100, 101, 99])).toThrow(/Not enough/);
  });

  it('extracts closes from a Yahoo chart payload, filtering nulls', () => {
    const json = {
      chart: {
        result: [
          {
            indicators: {
              quote: [{ close: [100.5, null, 101.25, 0, -5, 102] }],
            },
          },
        ],
      },
    };
    expect(closesFromYahooChart(json)).toEqual([100.5, 101.25, 102]);
  });

  it('throws a clear message for malformed Yahoo chart shapes', () => {
    expect(() => closesFromYahooChart({})).toThrow(/no result/);
    expect(() => closesFromYahooChart({ chart: { result: [{}] } })).toThrow(/no close series/);
    expect(() =>
      closesFromYahooChart({ chart: { result: [], error: { description: 'No data found' } } }),
    ).toThrow(/No data found/);
  });

  it('extracts (timestamp, close) pairs from a Yahoo chart payload, filtering nulls', () => {
    const DAY = 86400;
    const t0 = 1_700_000_000; // arbitrary epoch-seconds anchor
    const json = {
      chart: {
        result: [
          {
            timestamp: [t0, t0 + DAY, t0 + 2 * DAY, t0 + 3 * DAY, t0 + 4 * DAY, t0 + 5 * DAY],
            indicators: {
              quote: [{ close: [100.5, null, 101.25, 0, -5, 102] }],
            },
          },
        ],
      },
    };
    expect(closesWithDatesFromYahooChart(json)).toEqual([
      { t: t0, close: 100.5 },
      { t: t0 + 2 * DAY, close: 101.25 },
      { t: t0 + 5 * DAY, close: 102 },
    ]);
  });

  it('throws a clear message for malformed shapes (dated variant)', () => {
    expect(() => closesWithDatesFromYahooChart({})).toThrow(/no result/);
    expect(() => closesWithDatesFromYahooChart({ chart: { result: [{}] } })).toThrow(/no close series/);
  });

  describe('realizedCorrelation', () => {
    const DAY = 86400;
    const t0 = 1_700_000_000;
    // 40 daily bars so we clear the >=31-overlap threshold after log-returns.
    const N = 40;
    const days = Array.from({ length: N }, (_, i) => t0 + i * DAY);

    // Deterministic pseudo-random walk (Park-Miller LCG) shared as the base
    // series; "identical" duplicates it exactly, "negated" mirrors returns.
    function walk(seedStart: number): number[] {
      let seed = seedStart;
      const rand = () => {
        seed = (seed * 48271) % 2147483647;
        return seed / 2147483647;
      };
      let s = 100;
      const closes = [s];
      for (let i = 0; i < N - 1; i++) {
        const r = (rand() - 0.5) * 0.02; // small daily log-return
        s *= Math.exp(r);
        closes.push(s);
      }
      return closes;
    }

    it('is ~1 for identical series', () => {
      const base = walk(12345);
      const a = days.map((t, i) => ({ t, close: base[i] }));
      const b = days.map((t, i) => ({ t, close: base[i] }));
      expect(realizedCorrelation(a, b)).toBeCloseTo(1, 6);
    });

    it('is ~-1 for a negated-return series', () => {
      const base = walk(12345);
      // Build b whose log-returns are the exact negation of a's.
      const bCloses = [100];
      for (let i = 1; i < N; i++) {
        const ret = Math.log(base[i] / base[i - 1]);
        bCloses.push(bCloses[i - 1] * Math.exp(-ret));
      }
      const a = days.map((t, i) => ({ t, close: base[i] }));
      const b = days.map((t, i) => ({ t, close: bCloses[i] }));
      expect(realizedCorrelation(a, b)).toBeCloseTo(-1, 6);
    });

    it('is near 0 for two independent-ish walks', () => {
      const a = days.map((t, i) => ({ t, close: walk(11)[i] }));
      const b = days.map((t, i) => ({ t, close: walk(97531)[i] }));
      expect(Math.abs(realizedCorrelation(a, b))).toBeLessThan(0.5);
    });

    it('throws when there is not enough overlapping history', () => {
      const base = walk(12345);
      const a = days.map((t, i) => ({ t, close: base[i] }));
      // b lives on completely different calendar days -> zero overlap.
      const b = days.map((t, i) => ({ t: t + 1000 * DAY, close: base[i] }));
      expect(() => realizedCorrelation(a, b)).toThrow(/overlapping/);
    });
  });

  it('maps Yahoo symbols to per-source conventions', () => {
    expect(toCboeSymbol('^SPX')).toBe('_SPX');
    expect(toCboeSymbol('aapl')).toBe('AAPL');
    expect(() => toCboeSymbol('BMW.DE')).toThrow(/US options/);
    expect(() => toCboeSymbol('  ')).toThrow(/underlying/);
    expect(toStooqSymbol('BA')).toBe('ba.us');
    expect(toStooqSymbol('^SPX')).toBe('^spx');
    expect(toStooqSymbol('BMW.DE')).toBe('bmw.de');
  });
});
