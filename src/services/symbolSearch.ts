import { fetchTextWithCorsFallback } from './spotFetch';
import { normalizeQuoteCurrency } from './symbols';

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

/** Name/ticker autocomplete via Yahoo Finance's public search endpoint. */
export async function searchSymbols(query: string): Promise<SymbolMatch[]> {
  const q = query.trim();
  if (q.length < 1) return [];
  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (cached) return cached;
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
  const { text } = await fetchTextWithCorsFallback(
    url,
    SEARCH_TIMEOUT_MS,
    (t) => t.trimStart().startsWith('{'),
    SEARCH_HEDGE_MS,
  );
  const parsed = JSON.parse(text) as { quotes?: YahooSearchQuote[] };
  const out = (parsed.quotes ?? [])
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
  searchCache.set(key, out);
  return out;
}
