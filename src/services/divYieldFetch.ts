/**
 * Fetches the two series `realizedDivYield` needs, and derives a dividend yield
 * from price history alone.
 *
 * TWO CASES, because the total-return series comes from a different place for
 * each:
 *
 *  - A SINGLE STOCK or an ETF carries its own total-return series in Yahoo's
 *    chart response, as the ADJUSTED close, which reinvests dividends. So one
 *    request gives both series and the yield is the gap between them.
 *
 *  - A PRICE INDEX does not. There is no dividend adjustment to read, because
 *    an index level is not a holding: EURO STOXX 50 and the S&P 500 are both
 *    published as price indices that simply exclude dividends. So an index
 *    needs its own separately published GROSS RETURN counterpart, and the yield
 *    is the gap between the two indices. This is why the map below exists and
 *    why an index with no known counterpart reports that rather than guessing.
 */
import { fetchTextWithCorsFallback } from './spotFetch';
import { realizedDivYield, type RealizedDivYieldResult } from '../model/divYield';
import { isIndexSymbol } from './symbols';

/** Two years of history: long enough to average over several dividend cycles,
 * short enough that a payout policy change does not dominate the answer. */
const RANGE = '2y';

/**
 * Price index to its GROSS RETURN counterpart, which reinvests dividends.
 *
 * The pair must track the SAME constituents and differ only in dividend
 * treatment, or the gap between them measures index construction rather than
 * dividends. Net-return variants are deliberately avoided: they deduct a
 * withholding tax assumption, so the gap would understate the gross yield the
 * risk-neutral drift wants.
 */
const TOTAL_RETURN_INDEX: Record<string, string> = {
  '^GSPC': '^SP500TR',
  '^SPX': '^SP500TR',
};

export function totalReturnIndexFor(symbol: string): string | undefined {
  return TOTAL_RETURN_INDEX[symbol.toUpperCase()];
}

interface ChartSeries {
  close: number[];
  adjClose?: number[];
}

/**
 * Pulls the close series, and the adjusted close when the response carries one.
 * Both arrays keep their original length and their nulls, so the caller can
 * align them by index. `realizedDivYield` drops unusable pairs together.
 */
export function seriesFromYahooChart(json: unknown): ChartSeries {
  const parsed = json as {
    chart?: {
      result?: {
        indicators?: {
          quote?: { close?: (number | null)[] }[];
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
  const rawClose = result.indicators?.quote?.[0]?.close;
  if (!Array.isArray(rawClose)) throw new Error('Yahoo chart response has no close series');
  const close = rawClose.map((v) => (typeof v === 'number' ? v : NaN));
  const rawAdj = result.indicators?.adjclose?.[0]?.adjclose;
  const adjClose = Array.isArray(rawAdj) ? rawAdj.map((v) => (typeof v === 'number' ? v : NaN)) : undefined;
  return { close, adjClose };
}

async function fetchChart(symbol: string): Promise<unknown> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${RANGE}&interval=1d&events=div`;
  const { text } = await fetchTextWithCorsFallback(url, 8000, (t) => t.trimStart().startsWith('{'));
  return JSON.parse(text);
}

export interface DivYieldFetchResult extends RealizedDivYieldResult {
  source: string;
}

/**
 * The realized dividend yield for one underlying. Throws with a human message
 * when the history cannot support one, so the caller keeps whatever yield the
 * user already has rather than receiving a fabricated number.
 */
export async function fetchRealizedDivYield(symbol: string): Promise<DivYieldFetchResult> {
  if (isIndexSymbol(symbol)) {
    const trSymbol = totalReturnIndexFor(symbol);
    if (!trSymbol) {
      throw new Error(
        `No known total-return counterpart for the index "${symbol}", so its dividend yield cannot be measured from price history`,
      );
    }
    const [priceJson, trJson] = await Promise.all([fetchChart(symbol), fetchChart(trSymbol)]);
    const price = seriesFromYahooChart(priceJson).close;
    const total = seriesFromYahooChart(trJson).close;
    // The two index series are requested over the same range, but a missing
    // bar on one side would shift every later pair. Compare only the common
    // tail length, and require the lengths to be close enough that a shift
    // cannot be hiding.
    if (Math.abs(price.length - total.length) > 5) {
      throw new Error(`"${symbol}" and "${trSymbol}" returned mismatched history lengths`);
    }
    const n = Math.min(price.length, total.length);
    const r = realizedDivYield(total.slice(total.length - n), price.slice(price.length - n));
    return { ...r, source: `${symbol} vs ${trSymbol}` };
  }

  return divYieldFromChartPayload(symbol, await fetchChart(symbol));
}

/**
 * The single-name path, from a payload the caller ALREADY has.
 *
 * The vol model fetches two years of daily history for the same symbol (see
 * ./ohlcFetch's fetchDailyChart), and the adjusted close needed here rides in
 * that same response. So the pipeline passes the payload through rather than
 * spending a second request on identical data.
 */
export function divYieldFromChartPayload(symbol: string, payload: unknown): DivYieldFetchResult {
  const { close, adjClose } = seriesFromYahooChart(payload);
  if (!adjClose) {
    throw new Error(`Yahoo returned no adjusted close for "${symbol}", so dividends cannot be separated`);
  }
  const r = realizedDivYield(adjClose, close);
  return { ...r, source: `${symbol} adjusted close` };
}
