/**
 * Shared reader for Yahoo's chart-endpoint JSON payload, and the URL builder
 * for that same endpoint.
 *
 * WHY THIS FILE EXISTS: four call sites each re-declared the same nested
 * `{ chart: { result: [{ indicators: { quote, adjclose }, timestamp }] } }`
 * shape and each did its own null and error handling. They drifted once
 * already, and the drift caused a real bug. Parsing the envelope in ONE
 * place keeps every caller's null handling consistent, while each caller
 * still decides for itself which fields it needs and what to do with a
 * missing one.
 */

/** The fields every Yahoo chart consumer in this app cares about, still in
 * their raw (nullable) form. A caller picks the fields it needs and applies
 * its own drop/keep rule; this function does not decide that for it. */
interface YahooChartFields {
  timestamp?: number[];
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  adjClose?: (number | null)[];
}

/**
 * Parses the chart endpoint's envelope once: unwraps `chart.result[0]`,
 * throws the API's own error description when there is no result, and hands
 * back the raw parallel arrays. Does NOT validate `close` is present — some
 * callers (bars) need open/high/low too and choose their own required-field
 * rule, so that check stays with them.
 */
export function parseYahooChartFields(json: unknown): YahooChartFields {
  const parsed = json as {
    chart?: {
      result?: {
        timestamp?: number[];
        indicators?: {
          quote?: {
            open?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            close?: (number | null)[];
          }[];
          adjclose?: { adjclose?: (number | null)[] }[];
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
  return {
    timestamp: result.timestamp,
    open: q?.open,
    high: q?.high,
    low: q?.low,
    close: q?.close,
    adjClose: result.indicators?.adjclose?.[0]?.adjclose,
  };
}

/**
 * Builds a Yahoo chart-endpoint URL. `interval` is always daily here because
 * every caller in this app wants daily bars; `range` and `events` are left
 * to the caller because they genuinely differ per use (a 1-day spot check
 * wants `range=1d`, a two-year GARCH fit wants `range=2y&events=div`, and so
 * on). Making that choice explicit at the call site, instead of buried in a
 * template string, is the point: one path once ended up on `range=1y` with
 * no `events=div` while another used `range=2y` with it, silently, and nobody
 * could see the divergence by reading either call site alone.
 */
export function buildYahooChartUrl(symbol: string, range: string, opts?: { events?: string }): string {
  const events = opts?.events ? `&events=${opts.events}` : '';
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d${events}`;
}
