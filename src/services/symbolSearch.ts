import { fetchTextWithCorsFallback } from './spotFetch';

export interface SymbolMatch {
  symbol: string; // Yahoo-style: BA, ^SPX, BMW.DE
  name: string;
  exchange: string;
  quoteType: 'EQUITY' | 'INDEX' | 'ETF';
}

interface YahooSearchQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  quoteType?: string;
}

/** Name/ticker autocomplete via Yahoo Finance's public search endpoint. */
export async function searchSymbols(query: string): Promise<SymbolMatch[]> {
  const q = query.trim();
  if (q.length < 1) return [];
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
  const { text } = await fetchTextWithCorsFallback(url, 8000, (t) => t.trimStart().startsWith('{'));
  const parsed = JSON.parse(text) as { quotes?: YahooSearchQuote[] };
  return (parsed.quotes ?? [])
    .filter(
      (m): m is YahooSearchQuote & { symbol: string } =>
        !!m.symbol && (m.quoteType === 'EQUITY' || m.quoteType === 'INDEX' || m.quoteType === 'ETF'),
    )
    .map((m) => ({
      symbol: m.symbol,
      name: m.longname ?? m.shortname ?? m.symbol,
      exchange: m.exchDisp ?? '',
      quoteType: m.quoteType as SymbolMatch['quoteType'],
    }));
}
