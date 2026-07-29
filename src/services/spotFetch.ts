import { normalizeQuoteCurrency, toStooqSymbol } from './symbols';

export interface SpotFetchResult {
  spot: number;
  asOf: string;
  source: string;
  currency?: string;
}

/**
 * Fetch text with a hard timeout. Shared by every source that does not need
 * a CORS proxy, such as marketdata.app, which already sends
 * `access-control-allow-origin: *`.
 */
export async function fetchWithTimeout(url: string, ms: number, external?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // A caller can cancel this attempt early, which is how a hedged race stops
  // the losers as soon as one relay answers.
  const onExternalAbort = () => controller.abort();
  external?.addEventListener('abort', onExternalAbort);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`request timed out (${ms / 1000}s)`);
    throw e;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Public CORS relays, tried in order after a direct request fails. None needs a
 * key. They are listed most-reliable-first and deliberately more than two deep:
 * these services rate-limit and disappear without notice, and a single dead
 * relay used to take the whole fetch down with it.
 */
const PROXIES = [
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url: string) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url: string) => `https://thingproxy.freeboard.io/fetch/${url}`,
];

/**
 * The route that last worked for a given origin, remembered for the session.
 *
 * Index 0 is the direct request; 1 and up index PROXIES. Without this every
 * fetch restarts at the top of the list and re-pays the failure of any dead
 * route ahead of the live one. Keyed per ORIGIN, because a relay that serves
 * Yahoo happily may still refuse the ECB.
 */
const preferredRoute = new Map<string, number>();

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Milliseconds to wait for the current route before ALSO starting the next
 * one. Short enough that a slow relay does not decide the user's latency,
 * long enough that a healthy one answers alone and the others are never
 * started. */
const DEFAULT_HEDGE_MS = 700;

/**
 * Fetch text, falling back through public CORS relays when the origin does not
 * send CORS headers (Yahoo, Stooq, ECB, CBOE). Returns the body and whether a
 * relay was used. `isValid` guards against 200-with-garbage responses, such as
 * bot challenges or relay error pages, so they count as failures.
 *
 * Routes are HEDGED, not tried strictly in turn. The previous version awaited
 * each route to completion before starting the next, so one slow or dead relay
 * cost its whole timeout before anything else was attempted, and the worst case
 * was the SUM of five timeouts. Interactive callers, above all ticker search,
 * paid that on every keystroke.
 *
 * Now the preferred route starts immediately, the next one starts after
 * `hedgeMs` if no answer has arrived, and so on. The first valid response wins
 * and cancels the rest, so latency becomes the FASTEST responder rather than
 * the sum of the failures ahead of it. The winner is remembered for that
 * origin, so later fetches usually succeed on the first route with no hedging
 * at all.
 */
export async function fetchTextWithCorsFallback(
  url: string,
  ms = 5000,
  isValid: (text: string) => boolean = () => true,
  hedgeMs = DEFAULT_HEDGE_MS,
): Promise<{ text: string; proxied: boolean }> {
  const targets: (((u: string) => string) | null)[] = [null, ...PROXIES];
  const origin = originOf(url);
  const preferred = preferredRoute.get(origin) ?? 0;
  // Preferred route first, then the rest in their declared order.
  const order = [preferred, ...targets.map((_, i) => i).filter((i) => i !== preferred)];

  return new Promise<{ text: string; proxied: boolean }>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let settled = false;
    let started = 0;
    let failed = 0;
    let lastErr: unknown;
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      for (const c of controllers) c.abort();
    };

    const scheduleHedge = () => {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      if (started >= order.length) return;
      hedgeTimer = setTimeout(startNext, hedgeMs);
    };

    function startNext(): void {
      if (settled || started >= order.length) return;
      const idx = order[started++];
      const wrap = targets[idx];
      const controller = new AbortController();
      controllers.push(controller);
      scheduleHedge();
      fetchWithTimeout(wrap ? wrap(url) : url, ms, controller.signal)
        .then((text) => {
          if (settled) return;
          if (!isValid(text)) throw new Error('unexpected response body');
          settled = true;
          preferredRoute.set(origin, idx);
          finish();
          resolve({ text, proxied: idx !== 0 });
        })
        .catch((e) => {
          if (settled) return;
          lastErr = e;
          failed++;
          // A failure frees the slot immediately; do not wait out the hedge.
          if (started < order.length) startNext();
          else if (failed === order.length) {
            settled = true;
            finish();
            reject(lastErr instanceof Error ? lastErr : new Error('fetch failed'));
          }
        });
    }

    startNext();
  });
}

/** Clears the remembered routes. Tests only. */
export function __resetPreferredRoutes(): void {
  preferredRoute.clear();
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
  // Minor-unit listings, London's "GBp" pence, are converted to the major
  // currency, so the spot and the currency label always agree.
  const { currency, priceDivisor } = normalizeQuoteCurrency(meta.currency);
  return {
    spot: meta.regularMarketPrice / priceDivisor,
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : '',
    source: proxied ? 'yahoo (proxied)' : 'yahoo',
    currency,
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
 * Fetch a last or delayed price for a Yahoo-style symbol (BA, ^SPX,
 * BMW.DE). Tries the Yahoo chart endpoint first, for near-live prices,
 * then Stooq as backup. Callers surface the error message; never fail
 * silently.
 */
export async function fetchSpot(symbol: string): Promise<SpotFetchResult> {
  if (!symbol.trim()) throw new Error('Pick an underlying first');
  try {
    return await fetchSpotYahoo(symbol);
  } catch (yahooErr) {
    try {
      return await fetchSpotStooq(symbol);
    } catch {
      throw yahooErr instanceof Error ? yahooErr : new Error('Spot fetch failed. Enter the spot manually.');
    }
  }
}
