/**
 * Daily OPEN/HIGH/LOW/CLOSE bars from Yahoo's chart endpoint, for the
 * range-based volatility estimators in `../model/volEstimators` and the
 * GARCH term structure in `../model/garch`.
 *
 * WHY a separate file: `./marketFetch.ts` already fetches CLOSE-only series
 * from this same endpoint (`closesFromYahooChart`), but it has other
 * changes in flight and must not be touched here. This module is additive:
 * it reuses the SAME CORS-fallback transport (`fetchTextWithCorsFallback`
 * from `./spotFetch.ts`) so no new HTTP plumbing is written, and it parses
 * the open/high/low fields the chart endpoint already returns alongside
 * close but that nothing in the app reads yet.
 */
import { fetchTextWithCorsFallback } from './spotFetch';
import type { Bar } from '../model/volEstimators';
import { buildYahooChartUrl, parseYahooChartFields } from './yahooChart';

/** About 2 years of daily bars: a GJR-GARCH(1,1) fit needs enough return
 * observations to separate the ARCH and GARCH effects from noise (see
 * `../model/garch.ts`'s MIN_OBS_FOR_FIT), so this fetches more history than
 * the 1-year window the close-only path uses. */
const RANGE = '2y';

function isFiniteAndPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Parses Yahoo's chart-endpoint JSON into OHLC bars. A bar is dropped
 * entirely when any one of its four OHLC fields is missing, non-finite or
 * non-positive, so every bar this function returns is directly usable by
 * every estimator in `../model/volEstimators.ts` without a further guard.
 * The dividend/split-ADJUSTED close, when present, is carried alongside
 * (see `trackingIndexDivYield`).
 */
export function barsFromYahooChart(json: unknown): Bar[] {
  const fields = parseYahooChartFields(json);
  if (!Array.isArray(fields.close)) throw new Error('Yahoo chart response has no OHLC series');

  const out: Bar[] = [];
  for (let i = 0; i < fields.close.length; i++) {
    const o = fields.open?.[i];
    const h = fields.high?.[i];
    const l = fields.low?.[i];
    const c = fields.close?.[i];
    if (isFiniteAndPositive(o) && isFiniteAndPositive(h) && isFiniteAndPositive(l) && isFiniteAndPositive(c)) {
      const a = fields.adjClose?.[i];
      out.push({ open: o, high: h, low: l, close: c, adjClose: isFiniteAndPositive(a) ? a : undefined });
    }
  }
  return out;
}

/**
 * Fetches daily OHLC bars for a Yahoo-style symbol (BA, ^SPX, BMW.DE), via
 * the same chart endpoint and CORS-fallback transport as spot and hist-vol.
 */
async function fetchDailyBars(yahooSymbol: string): Promise<Bar[]> {
  return (await fetchDailyChart(yahooSymbol)).bars;
}

interface DailyChart {
  bars: Bar[];
  /** The raw parsed payload, so a second consumer does not have to refetch it.
   * The chart response carries the ADJUSTED close alongside open/high/low/close,
   * and the dividend yield is measured from the gap between the two (see
   * ../model/divYield). Both wanted the same two years of the same symbol, so
   * fetching twice spent a request for nothing, which matters because Yahoo
   * rate-limits per IP and one Fetch press already makes several calls. */
  payload: unknown;
}

/**
 * One chart request, parsed once, serving every consumer that wants daily
 * history for this symbol. Prefer this over calling the endpoint again.
 */
export async function fetchDailyChart(yahooSymbol: string): Promise<DailyChart> {
  const url = buildYahooChartUrl(yahooSymbol, RANGE, { events: 'div' });
  let text: string;
  try {
    ({ text } = await fetchTextWithCorsFallback(url, 8000, (t) => t.trimStart().startsWith('{')));
  } catch (e) {
    throw new Error(`Daily OHLC bars unavailable for "${yahooSymbol}": ${e instanceof Error ? e.message : 'fetch failed'}`);
  }
  const payload = JSON.parse(text);
  const bars = barsFromYahooChart(payload);
  if (bars.length === 0) throw new Error(`No OHLC bars returned for "${yahooSymbol}"`);
  return { bars, payload };
}

/**
 * Tracking ETFs for PRICE indexes, whose own adjusted close carries no
 * dividends (a price index has no total-return series on Yahoo). The ETF's
 * adjusted close does — FEZ reinvests the EURO STOXX 50 dividends it
 * collects. See `trackingIndexDivYield`.
 */
const TRACKING_ETFS: Record<string, string> = {
  '^STOXX50E': 'FEZ', // SPDR EURO STOXX 50
  '^GSPC': 'SPY', // SPDR S&P 500
  '^IXIC': 'QQQ', // Invesco NASDAQ 100
  '^DJI': 'DIA', // SPDR Dow Jones
  '^N225': 'EWJ', // iShares MSCI Japan
};

/**
 * Estimates a dividend yield for a PRICE index from its tracking ETF's
 * adjusted close — the endpoint this app already uses, no new transport.
 *
 * The adjusted close compounds dividends (and splits) into the price, so
 * over the same window the total-return drift ln(G_adj) exceeds the
 * price-return drift ln(G_price) by the dividend yield:
 *
 *   divYield ~= (ln(G_adj) - ln(G_price)) / years
 *
 * KNOWN UNDERSTATEMENT, labelled in the UI: the ETF's own fee and foreign
 * withholding come out of the dividends it pays, so the estimate sits below
 * the index's true gross dividend yield. It is also a backward-looking
 * average, not a forward consensus. Both caveats are honest: an
 * understated-but-real yield beats a structural zero on a price index.
 *
 * Returns undefined when the symbol has no tracking ETF, the ETF's bars
 * carry no adjusted close, or the window is too short to trust. Never
 * throws.
 */
export async function trackingIndexDivYield(indexSymbol: string): Promise<{ divYield: number; etf: string } | undefined> {
  const etf = TRACKING_ETFS[indexSymbol];
  if (!etf) return undefined;
  try {
    const bars = await fetchDailyBars(etf);
    const priced = bars.filter((b) => b.adjClose !== undefined);
    if (priced.length < 60) return undefined;
    const first = priced[0];
    const last = priced[priced.length - 1];
    if (!(last.close > 0) || !(last.adjClose! > 0) || !(first.close > 0)) return undefined;
    const years = priced.length / 252;
    const raw = (Math.log(last.adjClose! / first.adjClose!) - Math.log(last.close / first.close)) / years;
    // Sanity band: a real equity yield lives in [0, 15%]. Anything outside
    // is a data artefact (e.g. a split not reflected in one of the series).
    if (!(raw > 0) || !(raw < 0.15)) return undefined;
    return { divYield: raw, etf };
  } catch {
    return undefined;
  }
}
