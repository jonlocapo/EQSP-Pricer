/**
 * Alpha Vantage `HISTORICAL_OPTIONS` chain fetcher and converter.
 *
 * WHY this source: it returns the full end-of-day US option chain — every
 * strike, both sides, with a per-contract implied vol already computed — as
 * one JSON payload, and it sends `access-control-allow-origin: *`, so the
 * BROWSER can call it directly with no CORS proxy. That makes it the most
 * reliable chain source this app has, when a free API key is supplied. It
 * needs a key (the literal key "demo" works only for IBM, no `date` param,
 * useful as a smoke test) and the free tier is tightly rate-limited (about
 * 25 requests/day), so callers should cache aggressively and only spend a
 * request when nothing cheaper will do.
 *
 * The response is a flat array of contract rows, unlike Yahoo's or CBOE's
 * per-expiry ladders, so this module's job is purely to regroup that array
 * into the shared `OptionChain` shape the rest of the vol pipeline already
 * understands (see ./optionChain.ts). No pricing logic lives here.
 */
import { fetchTextWithCorsFallback } from './spotFetch';
import { yearsUntil, type ExpirySlice, type OptionChain, type OptionQuote } from './optionChain';

export interface AlphaVantageRow {
  contractID?: string;
  symbol?: string;
  expiration?: string;
  strike?: string | number;
  type?: string;
  last?: string | number;
  mark?: string | number;
  bid?: string | number;
  ask?: string | number;
  implied_volatility?: string | number;
}

interface AlphaVantageResponse {
  endpoint?: string;
  message?: string;
  data?: AlphaVantageRow[];
}

/** Parses a value that may arrive as a string or a number. Returns undefined
 * for anything that is not a finite number, rather than NaN. */
function toNum(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Converts the flat Alpha Vantage row array into the shared `OptionChain`
 * shape: grouped by expiration, calls and puts split, strikes ascending. A
 * row with a non-finite strike, an unrecognized `type`, or a non-positive
 * implied vol is skipped — one bad row must not sink the whole chain, and
 * `buildVolSurface` needs a usable `iv` on every point it keeps anyway.
 */
export function alphaVantageChainToOptionChain(
  rows: AlphaVantageRow[],
  symbol: string,
  spot: number,
): OptionChain {
  const byExpiry = new Map<string, { calls: OptionQuote[]; puts: OptionQuote[] }>();

  for (const row of rows) {
    const strike = toNum(row.strike);
    const iv = toNum(row.implied_volatility);
    const expiry = row.expiration;
    if (strike === undefined || strike <= 0) continue;
    if (iv === undefined || iv <= 0) continue;
    if (!expiry) continue;
    const type = row.type?.trim().toLowerCase();
    if (type !== 'call' && type !== 'put') continue;

    const quote: OptionQuote = {
      strike,
      bid: toNum(row.bid),
      ask: toNum(row.ask),
      last: toNum(row.last) ?? toNum(row.mark),
      iv,
    };
    let entry = byExpiry.get(expiry);
    if (!entry) byExpiry.set(expiry, (entry = { calls: [], puts: [] }));
    if (type === 'call') entry.calls.push(quote);
    else entry.puts.push(quote);
  }

  const slices: ExpirySlice[] = [...byExpiry.entries()]
    .map(([expiry, e]) => ({
      expiry,
      tYears: yearsUntil(expiry),
      calls: e.calls.sort((a, b) => a.strike - b.strike),
      puts: e.puts.sort((a, b) => a.strike - b.strike),
    }))
    .sort((a, b) => a.tYears - b.tYears);

  return { symbol, spot, slices, source: 'Alpha Vantage chain' };
}

/**
 * Fetches the full historical-options chain for `symbol` from Alpha Vantage
 * and converts it to an `OptionChain`. `spot` comes from the caller — Alpha
 * Vantage's option payload does not itself carry a live underlying price.
 */
export async function fetchAlphaVantageChain(symbol: string, apiKey: string, spot: number): Promise<OptionChain> {
  const sym = symbol.trim();
  if (!sym) throw new Error('Pick an underlying first');
  if (!apiKey.trim()) throw new Error('No Alpha Vantage API key set');
  if (!(spot > 0)) throw new Error('Need a positive spot to build an Alpha Vantage chain');

  const url = `https://www.alphavantage.co/query?function=HISTORICAL_OPTIONS&symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(apiKey)}`;
  const { text } = await fetchTextWithCorsFallback(url, 10_000, (t) => t.trimStart().startsWith('{'));
  const parsed = JSON.parse(text) as AlphaVantageResponse & { Information?: string; Note?: string; ['Error Message']?: string };

  // Alpha Vantage reports rate limits and bad keys as HTTP 200 with an
  // "Information"/"Note"/"Error Message" field instead of `data`.
  const softError = parsed.Information ?? parsed.Note ?? parsed['Error Message'];
  if (softError) throw new Error(`Alpha Vantage: ${softError}`);
  if (!Array.isArray(parsed.data) || parsed.data.length === 0) {
    throw new Error(`Alpha Vantage returned no option data for "${sym}"`);
  }

  const chain = alphaVantageChainToOptionChain(parsed.data, sym, spot);
  if (chain.slices.length === 0) {
    throw new Error(`Alpha Vantage chain for "${sym}" had no usable rows`);
  }
  return chain;
}
