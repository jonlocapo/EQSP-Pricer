/**
 * Listed volatility indices, fetched keylessly through the Yahoo chart
 * endpoint the app already uses for spot and realized-vol history.
 *
 * WHY this matters: a volatility index (VIX, VSTOXX, VDAX, ...) publishes the
 * market's own 30-day ATM IMPLIED volatility. It is not a derived estimate —
 * it is a genuine implied number, and it needs no option chain and no API
 * key. When the underlying has a listed index, this is the cheapest and most
 * trustworthy anchor the vol pipeline can reach for.
 *
 * The index PRINTS in vol points (for example 17.92), so callers divide by
 * 100 to get the decimal the rest of the app uses (0.1792).
 */
import { fetchTextWithCorsFallback } from './spotFetch';
import { closesWithDatesFromYahooChart } from './marketFetch';

/**
 * Maps a Yahoo-style underlying symbol to its listed volatility index. Only
 * underlyings with a real, liquid index are here — do not guess an index for
 * a name that does not have one; the pipeline degrades to a market-wide ratio
 * instead (see volPipeline.ts).
 */
const VOL_INDEX_BY_UNDERLYING: Record<string, string> = {
  '^GSPC': '^VIX',
  '^SPX': '^VIX',
  SPY: '^VIX',
  '^STOXX50E': '^V2TX',
  '^GDAXI': '^VDAX',
  '^NDX': '^VXN',
  '^IXIC': '^VXN',
  QQQ: '^VXN',
  '^RUT': '^RVX',
  IWM: '^RVX',
  '^FTSE': '^VFTSE',
};

/** The listed vol-index symbol for an underlying, or undefined when none exists. */
export function volIndexSymbolFor(underlying: string): string | undefined {
  return VOL_INDEX_BY_UNDERLYING[underlying.trim().toUpperCase()] ?? VOL_INDEX_BY_UNDERLYING[underlying.trim()];
}

export interface VolIndexLevel {
  symbol: string;
  /** Decimal (0.1792 = 17.92 points). */
  vol: number;
  asOf: string;
  source: string;
}

/**
 * Fetches the latest level of a vol-index symbol (for example `^VIX`). Uses a
 * short range, because a vol index can print a stale bar on some days — the
 * chart endpoint and CORS-proxy chain are the same ones `fetchSpot` and
 * `fetchHistVol` already rely on, so no new HTTP plumbing is added here.
 */
export async function fetchVolIndexLevel(symbol: string): Promise<VolIndexLevel> {
  const sym = symbol.trim();
  if (!sym) throw new Error('No vol-index symbol given');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
  const { text, proxied } = await fetchTextWithCorsFallback(url, 8000, (t) => t.trimStart().startsWith('{'));
  const closes = closesWithDatesFromYahooChart(JSON.parse(text));
  if (closes.length === 0) throw new Error(`No level returned for vol index "${sym}"`);
  const last = closes[closes.length - 1];
  if (!(last.close > 0)) throw new Error(`Vol index "${sym}" returned a non-positive level`);
  return {
    symbol: sym,
    vol: last.close / 100,
    asOf: new Date(last.t * 1000).toISOString(),
    source: proxied ? `yahoo ${sym} (proxied)` : `yahoo ${sym}`,
  };
}
