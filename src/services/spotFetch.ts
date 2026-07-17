export interface SpotFetchResult {
  spot: number;
  asOf: string;
  source: string;
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

async function fetchWithTimeout(url: string, ms: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch text, retrying through a public CORS proxy when the origin doesn't
 * send CORS headers (Stooq, ECB). Returns the body and whether the proxy
 * was used.
 */
export async function fetchTextWithCorsFallback(
  url: string,
  ms = 5000,
  isValid: (text: string) => boolean = () => true,
): Promise<{ text: string; proxied: boolean }> {
  try {
    const text = await fetchWithTimeout(url, ms);
    if (!isValid(text)) throw new Error('unexpected response body');
    return { text, proxied: false };
  } catch {
    const proxied = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
    const text = await fetchWithTimeout(proxied, ms);
    if (!isValid(text)) throw new Error('unexpected response body');
    return { text, proxied: true };
  }
}

/**
 * Fetch a last-traded price for `symbol` from Stooq, falling back to a CORS
 * proxy if the direct request fails. Never blocks manual entry — callers
 * should catch and show "Fetch unavailable — enter spot manually".
 */
export async function fetchSpot(symbol: string): Promise<SpotFetchResult> {
  const stooqUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&e=csv`;

  try {
    const csv = await fetchWithTimeout(stooqUrl, 5000);
    const { close, date } = parseStooqCsv(csv);
    return { spot: close, asOf: date, source: 'stooq' };
  } catch {
    // fall through to proxy
  }

  try {
    const proxied = `https://corsproxy.io/?url=${encodeURIComponent(stooqUrl)}`;
    const csv = await fetchWithTimeout(proxied, 5000);
    const { close, date } = parseStooqCsv(csv);
    return { spot: close, asOf: date, source: 'stooq (proxied)' };
  } catch {
    throw new Error('Fetch unavailable — enter spot manually');
  }
}
