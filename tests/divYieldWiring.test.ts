import { describe, expect, it } from 'vitest';
import { divYieldFromChartPayload, fetchRealizedDivYield, totalReturnIndexFor } from '../src/services/divYieldFetch';
import { barsFromYahooChart } from '../src/services/ohlcFetch';
import { fetchRealizedStats } from '../src/services/marketFetch';
import { riskNeutralDrift } from '../src/model/market';
import type { MarketData } from '../src/model/market';

/**
 * The dividend yield is now MEASURED from price history and handed to the
 * pricing drift, and it reads the chart response the vol model already fetched
 * rather than requesting the same two years again.
 *
 * Five tests, each aimed at a different way that wiring could be wrong: the
 * shared payload could be misread, the request could still be duplicated, an
 * index could silently produce a wrong number instead of declining, a failure
 * could overwrite a good value, or the yield could reach the drift with the
 * wrong sign.
 */

const DAYS = 505;

/**
 * A Yahoo chart payload carrying a KNOWN dividend yield: the adjusted close
 * accrues the yield on top of the raw close, which is exactly what dividend
 * reinvestment does.
 */
function chartPayload(yieldPa: number, opts: { withAdjClose?: boolean } = {}) {
  const { withAdjClose = true } = opts;
  const close: number[] = [];
  const adj: number[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  let s = 100;
  let cum = 0;
  let a = 11;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return (a + 0.5) / 4294967296 - 0.5;
  };
  for (let i = 0; i < DAYS; i++) {
    if (i > 0) {
      s *= Math.exp(0.0002 + 0.01 * rnd());
      cum += yieldPa / 252;
    }
    close.push(s);
    adj.push(s * Math.exp(cum));
    open.push(s * 0.999);
    high.push(s * 1.004);
    low.push(s * 0.996);
  }
  return {
    chart: {
      result: [
        {
          indicators: {
            quote: [{ open, high, low, close }],
            ...(withAdjClose ? { adjclose: [{ adjclose: adj }] } : {}),
          },
        },
      ],
    },
  };
}

describe('dividend yield wiring', () => {
  it('reads the yield out of the payload the vol model already fetched', () => {
    // One response has to serve both consumers. If the shared payload were
    // misread, this is where it shows up, and it is the whole reason the extra
    // request was removed.
    const payload = chartPayload(0.031);
    const r = divYieldFromChartPayload('X', payload);
    expect(r.divYield).toBeCloseTo(0.031, 9);
    expect(r.days).toBe(DAYS);
    // And the SAME payload still yields usable OHLC bars for the vol model, so
    // sharing it has not damaged the other consumer.
    expect(barsFromYahooChart(payload)).toHaveLength(DAYS);
  });

  it('makes no network call at all on the shared path', async () => {
    // The point of the change is one request, not two. A duplicate would have
    // to go through fetch, so failing the global fetch proves the shared path
    // never touches the network.
    const real = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('the shared path must not fetch');
    }) as unknown as typeof fetch;
    try {
      expect(divYieldFromChartPayload('X', chartPayload(0.02)).divYield).toBeCloseTo(0.02, 9);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('the close-only fallback carries a payload, so the dividend needs no second request', async () => {
    // The German-stock bug: when the OHLC path (fetchRealizedVolStats) fails
    // and the close-only fallback (fetchRealizedStats) runs, the fallback used
    // to return no payload. The dividend code then made its OWN second chart
    // request — the duplicate PR #18 removed, quietly back on the fallback
    // path, and the one Yahoo rate-limits away. Fix: the fallback reads the
    // SAME shared chart fetch (two years, events=div, adjusted close) and
    // carries the payload, so whichever estimator ran, the yield reads a
    // response that already exists.
    const real = globalThis.fetch;
    let chartHits = 0;
    globalThis.fetch = ((url: string) =>
      new Promise((resolve, reject) => {
        const u = String(url);
        if (u.includes('v8/finance/chart')) {
          chartHits += 1;
          resolve({ ok: true, text: async () => JSON.stringify(chartPayload(0.027)) } as Response);
        } else {
          reject(new Error(`unexpected request: ${u}`));
        }
      })) as unknown as typeof fetch;
    try {
      const stats = await fetchRealizedStats('RHM.DE');
      expect(stats.payload).toBeDefined();
      // The payload the fallback returned is the same two years the yield
      // measures from, so the measurement is a pure function of it — no
      // second request for the dividend.
      const dy = divYieldFromChartPayload('RHM.DE', stats.payload);
      expect(dy.divYield).toBeCloseTo(0.027, 9);
      expect(chartHits).toBeGreaterThanOrEqual(1);
      // And the SAME payload still served the vol stats, i.e. one response
      // carried both consumers even on the fallback path.
      expect(stats.days).toBe(DAYS - 1);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('declines on an index with no total-return counterpart, rather than guessing', async () => {
    // A price index has no adjusted close to read. Returning a wrong yield here
    // would bias the forward on every note, so it must refuse and let the
    // entered value stand. SX5E is the default underlying and has no
    // counterpart mapped, which makes this the live case, not a corner one.
    expect(totalReturnIndexFor('^STOXX50E')).toBeUndefined();
    await expect(fetchRealizedDivYield('^STOXX50E')).rejects.toThrow(/no known total-return counterpart/i);
    // An index payload has no adjclose even if one is somehow fetched.
    expect(() => divYieldFromChartPayload('^STOXX50E', chartPayload(0.03, { withAdjClose: false }))).toThrow(
      /no adjusted close/i,
    );
  });

  it('refuses a mismatched pair instead of writing a wrong yield', () => {
    // Every rejection path matters more than the happy one: a bad yield is
    // silently wrong, whereas a refusal leaves the user's own number in place.
    // A 60% reading means the two series do not correspond, not a 60% payer.
    expect(() => divYieldFromChartPayload('X', chartPayload(0.6))).toThrow(/implausible/i);
    expect(() => divYieldFromChartPayload('X', { chart: { result: [{}] } })).toThrow(/no close series/i);
    expect(() => divYieldFromChartPayload('X', {})).toThrow(/no result/i);
  });

  it('reaches the drift with the right sign, so a payer lowers the forward', () => {
    // The measurement is only worth anything if it lands in the drift the right
    // way round. mu = rate - divYield - borrow, so a dividend must pull the
    // forward DOWN, and a measured 3% must move it exactly 3%.
    const measured = divYieldFromChartPayload('X', chartPayload(0.03)).divYield;
    const base: MarketData = { spot: 100, vol: 0.2, rate: 0.04, divYield: 0, currency: 'EUR' };
    const withYield: MarketData = { ...base, divYield: measured };
    expect(riskNeutralDrift(withYield)).toBeLessThan(riskNeutralDrift(base));
    expect(riskNeutralDrift(base) - riskNeutralDrift(withYield)).toBeCloseTo(0.03, 9);
  });
});
