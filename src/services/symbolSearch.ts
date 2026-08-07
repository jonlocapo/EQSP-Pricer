import { fetchTextWithCorsFallback } from './spotFetch';
import { normalizeQuoteCurrency } from './symbols';
import { searchLocalUniverse } from './localUniverse';

export interface SymbolMatch {
  symbol: string; // Yahoo-style: BA, ^SPX, BMW.DE
  name: string;
  exchange: string;
  quoteType: 'EQUITY' | 'INDEX' | 'ETF';
  /** Listing currency, when the search response carries one. Lets the note
   * currency follow the underlying on pick (see marketStore.setUnderlying),
   * instead of silently leaving a USD name in a EUR note. */
  currency?: string;
}

interface YahooSearchQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  quoteType?: string;
  currency?: string;
}

/**
 * Results already fetched this session, keyed by the normalised query.
 *
 * Typing walks through prefixes and backspacing revisits them, so the same
 * query is asked for repeatedly within seconds. A search is a pure lookup whose
 * answer does not move on that timescale, so serving a repeat from memory
 * removes the network entirely and makes the dropdown feel instant.
 */
const searchCache = new Map<string, SymbolMatch[]>();

/** Interactive timeout. Search runs on a keystroke, so waiting 8 seconds for a
 * relay is worse than reporting no answer and letting the next keystroke try
 * again. */
const SEARCH_TIMEOUT_MS = 4000;
/** Start the next relay sooner than the default: this is the one call the user
 * watches a spinner for. */
const SEARCH_HEDGE_MS = 400;

/**
 * Accepts only a body that actually looks like a Yahoo search response.
 *
 * This runs inside the hedged race, so it decides which route WINS. The old
 * check was "starts with a brace", which a relay's own JSON error envelope
 * satisfies. That envelope therefore won the race, aborted the routes still in
 * flight, and produced zero matches for a real ticker. Requiring the `quotes`
 * key means a relay error loses the race and a working route can still win.
 */
function isSearchResponse(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('{') && t.includes('"quotes"');
}

/**
 * Name and ticker autocomplete.
 *
 * TWO SOURCES, and the local one answers first. `searchLocalUniverse` is a
 * built-in list of the underlyings a desk actually uses, so typing a NAME works
 * with no network at all. Yahoo's endpoint then covers everything outside that
 * list, and its answers win on merge because they carry the live name, exchange
 * and listing currency.
 *
 * `onLocal` receives the local matches straight away, before the network call
 * starts. The dropdown can paint them immediately instead of holding a spinner
 * for up to four seconds, and they stay on screen if the network never answers.
 */
export async function searchSymbols(
  query: string,
  onLocal?: (matches: SymbolMatch[]) => void,
): Promise<SymbolMatch[]> {
  const q = query.trim();
  if (q.length < 1) return [];
  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (cached) return cached;

  const local = searchLocalUniverse(q);
  if (local.length > 0) onLocal?.(local);

  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
  let text: string;
  try {
    ({ text } = await fetchTextWithCorsFallback(
      url,
      SEARCH_TIMEOUT_MS,
      isSearchResponse,
      SEARCH_HEDGE_MS,
    ));
  } catch (e) {
    // The relays are down. A local hit is still a real answer, so serve it
    // rather than reporting a failure the user can do nothing about. Only a
    // query the built-in list cannot answer is a genuine failure.
    if (local.length > 0) return local;
    throw e;
  }
  const parsed = JSON.parse(text) as { quotes?: YahooSearchQuote[] };
  // A response with no `quotes` key at all is a FAILED response, not an empty
  // result set. Yahoo sends `"quotes":[]` when it genuinely knows nothing. So
  // throw here, which lets the caller report that search is unavailable rather
  // than telling the user a real ticker does not exist.
  if (!Array.isArray(parsed.quotes)) {
    if (local.length > 0) return local;
    throw new Error('Search response carried no quotes list');
  }
  const network = parsed.quotes
    .filter(
      (m): m is YahooSearchQuote & { symbol: string } =>
        !!m.symbol && (m.quoteType === 'EQUITY' || m.quoteType === 'INDEX' || m.quoteType === 'ETF'),
    )
    .map((m) => ({
      symbol: m.symbol,
      name: m.longname ?? m.shortname ?? m.symbol,
      exchange: m.exchDisp ?? '',
      quoteType: m.quoteType as SymbolMatch['quoteType'],
      currency: normalizeQuoteCurrency(m.currency).currency,
    }));
  // Merge, network first. A symbol in both lists keeps the network's row, which
  // carries the live name and listing currency. Local rows the network did not
  // return are appended, so a relay that answers with a thin list never hides a
  // name the built-in list knows.
  const seen = new Set(network.map((m) => m.symbol.toUpperCase()));
  const out = [...network, ...local.filter((m) => !seen.has(m.symbol.toUpperCase()))];

  // Cache HITS only. An empty result is not worth remembering, and remembering
  // it is actively harmful: an empty array is truthy, so it would be served
  // from the cache for the rest of the session and no later attempt could ever
  // replace it. One bad answer must not poison a query permanently.
  if (out.length > 0) searchCache.set(key, out);
  return out;
}

/** Empties the query cache. Tests only. */
export function __clearSearchCacheForTests(): void {
  searchCache.clear();
}
