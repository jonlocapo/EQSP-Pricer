import { toStooqSymbol } from './symbols';

export interface SpotFetchResult {
  spot: number;
  asOf: string;
  source: string;
  currency?: string;
}

async function fetchWithTimeout(url: string, ms: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`request timed out (${ms / 1000}s)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const PROXIES = [
  (url: string) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

/**
 * Fetch text, retrying through public CORS proxies when the origin doesn't
 * send CORS headers (Yahoo, Stooq, ECB, CBOE). Returns the body and whether
 * a proxy was used. `isValid` guards against 200-with-garbage responses
 * (bot challenges, proxy error pages) so they count as failures.
 */
export async function fetchTextWithCorsFallback(
  url: string,
  ms = 5000,
  isValid: (text: string) => boolean = () => true,
): Promise<{ text: string; proxied: boolean }> {
  let lastErr: unknown;
  for (const wrap of [null, ...PROXIES]) {
    try {
      const text = await fetchWithTimeout(wrap ? wrap(url) : url, ms);
      if (!isValid(text)) throw new Error('unexpected response body');
      return { text, proxied: wrap !== null };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

function parseStooqCsv(csv: string): { close: number; date: string } {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) throw new Error('empty response');
  const cols = lines[1].split(',');
  // Symbol,Date,Time,Open,High,Low,Close,Volume
  const date = cols[1];
  const time = cols[2];
  const close = Number(cols[6]);
  if (!Number.isFinite(close) || close <= 0) throw new Error('no price');
  return { close, date: `${date}T${time}` };
}

async function fetchSpotYahoo(symbol: string): Promise<SpotFetchResult> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const { text, proxied } = await fetchTextWithCorsFallback(url, 8000, (t) => t.trimStart().startsWith('{'));
  const parsed = JSON.parse(text) as {
    chart?: {
      result?: { meta?: { regularMarketPrice?: number; currency?: string; regularMarketTime?: number } }[];
      error?: { description?: string } | null;
    };
  };
  const meta = parsed.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice || !(meta.regularMarketPrice > 0)) {
    throw new Error(parsed.chart?.error?.description ?? `Yahoo has no price for "${symbol}"`);
  }
  return {
    spot: meta.regularMarketPrice,
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : '',
    source: proxied ? 'yahoo (proxied)' : 'yahoo',
    currency: meta.currency,
  };
}

async function fetchSpotStooq(symbol: string): Promise<SpotFetchResult> {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(toStooqSymbol(symbol))}&f=sd2t2ohlcv&e=csv`;
  const { text, proxied } = await fetchTextWithCorsFallback(
    url,
    5000,
    (t) => !t.trimStart().startsWith('<'),
  );
  const { close, date } = parseStooqCsv(text);
  return { spot: close, asOf: date, source: proxied ? 'stooq (proxied)' : 'stooq' };
}

/**
 * Fetch a last/delayed price for a Yahoo-style symbol (BA, ^SPX, BMW.DE).
 * Yahoo chart endpoint first (near-live), Stooq as backup. Callers surface
 * the error message — never fail silently.
 */
export async function fetchSpot(symbol: string): Promise<SpotFetchResult> {
  if (!symbol.trim()) throw new Error('Pick an underlying first');
  try {
    return await fetchSpotYahoo(symbol);
  } catch (yahooErr) {
    try {
      return await fetchSpotStooq(symbol);
    } catch {
      throw yahooErr instanceof Error ? yahooErr : new Error('Spot fetch failed — enter manually');
    }
  }
}
