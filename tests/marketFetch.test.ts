import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  annualizedVolFromCloses,
  closesFromYahooChart,
  closesWithDatesFromYahooChart,
  fetchBasketLegFxParams,
  fetchFxRealizedVolAndCorr,
  fetchHistVol,
  fetchRefRate,
  parseBocCorra,
  parseBojTona,
  parseHkmaHibor,
  parseFredLatestPercent,
  parseSnbSaron,
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

  it('fetches SONIA for GBP', async () => {
    const r = await fetchRefRate('GBP');
    expect(Number.isFinite(r.rate)).toBe(true);
    expect(r.rate).toBeGreaterThan(-0.01);
    expect(r.rate).toBeLessThan(0.15);
    expect(r.source).toContain('SONIA');
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('fetches SARON for CHF', async () => {
    const r = await fetchRefRate('CHF');
    expect(Number.isFinite(r.rate)).toBe(true);
    // CHF policy rates go negative, so the band floors well below zero.
    expect(r.rate).toBeGreaterThan(-0.01);
    expect(r.rate).toBeLessThan(0.15);
    expect(r.source).toContain('SARON');
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('fetches TONA for JPY', async () => {
    const r = await fetchRefRate('JPY');
    expect(Number.isFinite(r.rate)).toBe(true);
    // JPY rates can legitimately sit near zero or slightly negative.
    expect(r.rate).toBeGreaterThan(-0.01);
    expect(r.rate).toBeLessThan(0.15);
    expect(r.source).toContain('TONA');
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects unsupported currencies with a friendly message', async () => {
    await expect(fetchRefRate('SEK')).rejects.toThrow(/manually/);
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
    await expect(fetchRefRate('SEK')).rejects.toThrow(/Enter the rate manually/i);
  });

  describe('parseFredLatestPercent (BoE SONIA via FRED)', () => {
    // Real shape of https://fred.stlouisfed.org/graph/fredgraph.csv?id=IUDSOIA
    const FIXTURE = ['observation_date,IUDSOIA', '2026-07-21,3.7302', '2026-07-22,3.7303', '2026-07-23,3.7310', '2026-07-24,3.7307'].join(
      '\n',
    );

    it('picks the latest row and keeps the value in percent form', () => {
      const { asOf, ratePercent } = parseFredLatestPercent(FIXTURE);
      expect(asOf).toBe('2026-07-24');
      expect(ratePercent).toBeCloseTo(3.7307, 6);
    });

    it('skips a trailing FRED "." placeholder for a not-yet-published day', () => {
      const withGap = `${FIXTURE}\n2026-07-27,.`;
      const { asOf, ratePercent } = parseFredLatestPercent(withGap);
      expect(asOf).toBe('2026-07-24');
      expect(ratePercent).toBeCloseTo(3.7307, 6);
    });

    it('throws rather than returning 0 for an empty body', () => {
      expect(() => parseFredLatestPercent('observation_date,IUDSOIA')).toThrow(/empty|no numeric/i);
      expect(() => parseFredLatestPercent('')).toThrow(/empty|no numeric/i);
    });

    it('throws rather than returning NaN when every row is a placeholder', () => {
      expect(() => parseFredLatestPercent('observation_date,IUDSOIA\n2026-07-24,.')).toThrow(/no numeric/i);
    });
  });

  describe('parseSnbSaron', () => {
    // Real shape of https://data.snb.ch/api/cube/snbgwdzid/data/json/en?dimSel=D0(SARON)
    const FIXTURE = JSON.stringify({
      timeseries: [
        {
          header: [{ dim: 'Overview', dimItem: 'SARON fixing at the close of the trading day' }],
          metadata: { key: 'EPB@SNB.snbgwdzid{SARON}', frequency: 'P1D_L', scale: '', unit: 'In percent' },
          values: [
            { date: '2026-07-21', value: -0.04 },
            { date: '2026-07-22', value: -0.04 },
            { date: '2026-07-23', value: -0.04 },
            { date: '2026-07-24', value: -0.04 },
          ],
        },
      ],
    });

    it('picks the latest observation and keeps a negative rate negative', () => {
      const { asOf, ratePercent } = parseSnbSaron(FIXTURE);
      expect(asOf).toBe('2026-07-24');
      expect(ratePercent).toBeCloseTo(-0.04, 6);
    });

    it('throws rather than returning 0 for an empty values array', () => {
      expect(() =>
        parseSnbSaron(JSON.stringify({ timeseries: [{ values: [] }] })),
      ).toThrow(/no SARON value/);
    });

    it('throws for a malformed body instead of yielding NaN', () => {
      expect(() => parseSnbSaron('{}')).toThrow(/no SARON value/);
      expect(() => parseSnbSaron('not json')).toThrow();
    });
  });

  describe('parseBojTona', () => {
    // Real shape of https://www.stat-search.boj.or.jp/api/v1/getDataCode
    // (db=FM01, code=STRDCLUCON), trimmed to a few days including the
    // weekend nulls the live series actually returns.
    const FIXTURE = JSON.stringify({
      STATUS: 200,
      MESSAGEID: 'M181000I',
      MESSAGE: 'Successfully completed',
      RESULTSET: [
        {
          SERIES_CODE: 'STRDCLUCON',
          NAME_OF_TIME_SERIES: 'Call Rate, Uncollateralized Overnight, Average (Daily)',
          UNIT: 'percent per annum',
          FREQUENCY: 'DAILY',
          VALUES: {
            SURVEY_DATES: [20260723, 20260724, 20260725, 20260726, 20260727],
            VALUES: [0.727, 0.728, null, null, 0.727],
          },
        },
      ],
    });

    it('picks the latest non-null day, skipping weekend nulls', () => {
      const { asOf, ratePercent } = parseBojTona(FIXTURE);
      expect(asOf).toBe('2026-07-27');
      expect(ratePercent).toBeCloseTo(0.727, 6);
    });

    it('throws rather than returning 0 when every value is null', () => {
      const allNull = JSON.stringify({
        RESULTSET: [{ VALUES: { SURVEY_DATES: [20260726, 20260727], VALUES: [null, null] } }],
      });
      expect(() => parseBojTona(allNull)).toThrow(/no TONA value/);
    });

    it('throws for a malformed body instead of yielding NaN', () => {
      expect(() => parseBojTona('{}')).toThrow(/no TONA value/);
      expect(() => parseBojTona('not json')).toThrow();
    });
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

  describe('parseHkmaHibor (HKD)', () => {
    // Real shape of the HKMA daily-figures endpoint. The API answers newest
    // record first, and a Hong Kong public holiday leaves the rate null.
    const body = (records: unknown[]) =>
      JSON.stringify({ header: { success: true }, result: { datasize: records.length, records } });

    it('reads the newest overnight fixing and keeps it in percent form', () => {
      const { asOf, ratePercent } = parseHkmaHibor(
        body([
          { end_of_date: '2026-08-11', hibor_overnight: 2.03, hibor_fixing_1m: 2.614 },
          { end_of_date: '2026-08-08', hibor_overnight: 1.98 },
        ]),
      );
      expect(asOf).toBe('2026-08-11');
      expect(ratePercent).toBe(2.03);
    });

    it('skips a holiday row rather than returning null as zero', () => {
      const { asOf, ratePercent } = parseHkmaHibor(
        body([
          { end_of_date: '2026-08-11', hibor_overnight: null },
          { end_of_date: '2026-08-08', hibor_overnight: 1.98 },
        ]),
      );
      expect(asOf).toBe('2026-08-08');
      expect(ratePercent).toBe(1.98);
    });

    it('throws rather than returning 0 for an empty result', () => {
      expect(() => parseHkmaHibor(body([]))).toThrow(/HIBOR/);
    });
  });

  describe('parseBocCorra (CAD)', () => {
    // Real shape of the Bank of Canada Valet API, oldest observation first,
    // with the value as a string.
    const FIXTURE = JSON.stringify({
      observations: [
        { d: '2026-08-06', 'AVG.INTWO': { v: '2.2900' } },
        { d: '2026-08-07', 'AVG.INTWO': { v: '2.2850' } },
        { d: '2026-08-10', 'AVG.INTWO': { v: '2.2800' } },
      ],
    });

    it('picks the last observation and parses the string value', () => {
      const { asOf, ratePercent } = parseBocCorra(FIXTURE);
      expect(asOf).toBe('2026-08-10');
      expect(ratePercent).toBe(2.28);
    });

    it('throws rather than returning NaN for a malformed body', () => {
      expect(() => parseBocCorra(JSON.stringify({ observations: [] }))).toThrow(/CORRA/);
    });
  });

  describe('fetchBasketLegFxParams (per-leg quanto inputs)', () => {
    // A synthetic Yahoo chart payload. Each symbol gets its own series, so a
    // wrong pairing shows up as a wrong correlation rather than passing
    // silently.
    const DAY = 86_400;
    const T0 = 1_700_000_000;
    const N = 300;

    function chartBody(seed: number): string {
      const timestamp: number[] = [];
      const close: number[] = [];
      let x = seed;
      let level = 100;
      for (let i = 0; i < N; i++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        level *= 1 + ((x / 2147483648) - 0.5) * 0.02;
        timestamp.push(T0 + i * DAY);
        close.push(level);
      }
      return JSON.stringify({ chart: { result: [{ timestamp, indicators: { quote: [{ close }] } }] } });
    }

    /** Serves a distinct series per symbol, whichever route asks for it: the
     * relay URLs carry the target URL, encoded, so the symbol is still in the
     * string. */
    function stubChartFetch(): string[] {
      const asked: string[] = [];
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = decodeURIComponent(String(input));
        const symbol = /chart\/([^?]+)\?/.exec(url)?.[1] ?? '';
        asked.push(symbol);
        if (symbol === 'BOOM') throw new Error('no history for BOOM');
        let seed = 7;
        for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) % 100_000;
        return new Response(chartBody(seed + 1), { status: 200 });
      });
      return asked;
    }

    afterEach(() => vi.unstubAllGlobals());

    it('measures only the foreign legs, and fetches each currency once', async () => {
      const asked = stubChartFetch();
      const { legs, errors } = await fetchBasketLegFxParams(
        [
          { ticker: 'BMW.DE', currency: 'EUR' },
          { ticker: 'LMT', currency: 'USD' },
          { ticker: 'AAPL', currency: 'USD' },
        ],
        'EUR',
      );
      expect(errors).toEqual([]);
      // Leg 0 already settles in the note currency: no correction, nothing
      // measured, and no request for its equity history either.
      expect(legs[0]).toBeUndefined();
      expect(asked).not.toContain('BMW.DE');
      // One FX series for both USD legs, not two.
      expect(asked.filter((s) => s === 'USDEUR=X')).toHaveLength(1);

      for (const leg of [legs[1]!, legs[2]!]) {
        expect(leg.currency).toBe('USD');
        expect(leg.fxVol).toBeGreaterThan(0);
        expect(leg.corrEqFx).toBeGreaterThanOrEqual(-1);
        expect(leg.corrEqFx).toBeLessThanOrEqual(1);
        expect(leg.days).toBeGreaterThan(100);
      }
      // Two different equities against one FX series give two different
      // correlations. Equal values would mean the legs were not paired with
      // their own history.
      expect(legs[1]!.corrEqFx).not.toBe(legs[2]!.corrEqFx);
      expect(legs[1]!.index).toBe(1);
      expect(legs[2]!.index).toBe(2);
    });

    it('reports a failed leg and leaves it unmeasured, without blocking the others', async () => {
      stubChartFetch();
      const { legs, errors } = await fetchBasketLegFxParams(
        [
          { ticker: 'BOOM', currency: 'USD' },
          { ticker: 'LMT', currency: 'USD' },
        ],
        'EUR',
      );
      expect(legs[0]).toBeUndefined();
      expect(legs[1]).toBeDefined();
      expect(errors.join(' ')).toMatch(/BOOM/);
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
