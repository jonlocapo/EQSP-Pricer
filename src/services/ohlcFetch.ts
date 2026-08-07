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

/** About 2 years of daily bars: a GARCH(1,1) fit needs enough return
 * observations to separate the ARCH and GARCH effects from noise (see
 * `../model/garch.ts`'s MIN_OBS_FOR_FIT), so this fetches more history than
 * the 1-year window the close-only path uses. */
const RANGE = '2y';

function isFiniteAndPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Parses Yahoo's chart-endpoint JSON into OHLC bars. A bar is dropped
 * entirely when any one of its four fields is missing, non-finite or
 * non-positive, so every bar this function returns is directly usable by
 * every estimator in `../model/volEstimators.ts` without a further guard.
 */
export function barsFromYahooChart(json: unknown): Bar[] {
  const parsed = json as {
    chart?: {
      result?: {
        indicators?: {
          quote?: {
            open?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            close?: (number | null)[];
          }[];
        };
      }[];
      error?: { description?: string } | null;
    };
  };
  const result = parsed?.chart?.result?.[0];
  if (!result) {
    throw new Error(parsed?.chart?.error?.description ?? 'Yahoo chart response has no result');
  }
  const q = result.indicators?.quote?.[0];
  if (!q || !Array.isArray(q.close)) throw new Error('Yahoo chart response has no OHLC series');

  const out: Bar[] = [];
  for (let i = 0; i < q.close.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (isFiniteAndPositive(o) && isFiniteAndPositive(h) && isFiniteAndPositive(l) && isFiniteAndPositive(c)) {
      out.push({ open: o, high: h, low: l, close: c });
    }
  }
  return out;
}

/**
 * Fetches daily OHLC bars for a Yahoo-style symbol (BA, ^SPX, BMW.DE), via
 * the same chart endpoint and CORS-fallback transport as spot and hist-vol.
 */
export async function fetchDailyBars(yahooSymbol: string): Promise<Bar[]> {
  return (await fetchDailyChart(yahooSymbol)).bars;
}

export interface DailyChart {
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${RANGE}&interval=1d&events=div`;
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
