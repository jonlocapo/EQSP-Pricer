/**
 * Best-effort open-data market fetches beyond spot. Sources are free and
 * keyless, hence limited:
 *  - Historical (realized) volatility from Stooq daily closes — a rough
 *    starting point for the vol input, NOT implied vol.
 *  - Official overnight reference rates: ECB €STR (EUR) and NY Fed SOFR
 *    (USD). Daily fixings, not a live curve.
 * Everything is a suggestion; manual override always wins.
 */
import { fetchTextWithCorsFallback } from './spotFetch';
import { toStooqSymbol } from './symbols';

/** Stooq serves an HTML bot-challenge with HTTP 200 to some IPs; treat any
 * non-CSV body as a failed attempt so the proxy fallback kicks in. */
function looksLikeCsv(text: string): boolean {
  const head = text.trimStart().slice(0, 1);
  return head !== '<' && text.includes(',');
}

export interface HistVolResult {
  /** Annualized log-return volatility, decimal. */
  vol: number;
  days: number;
  source: string;
}

/** Annualized log-return volatility from a daily close series (~1Y window). */
export function annualizedVolFromCloses(closes: number[]): { vol: number; days: number } {
  const window = closes.slice(-253); // ~1Y of daily closes
  if (window.length < 30) throw new Error('Not enough price history for a vol estimate');
  const rets: number[] = [];
  for (let i = 1; i < window.length; i++) rets.push(Math.log(window[i] / window[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (rets.length - 1);
  return { vol: Math.sqrt(variance * 252), days: rets.length };
}

/** Extracts the daily close series from a Yahoo chart-endpoint JSON payload. */
export function closesFromYahooChart(json: unknown): number[] {
  const parsed = json as {
    chart?: {
      result?: { indicators?: { quote?: { close?: (number | null)[] }[] } }[];
      error?: { description?: string } | null;
    };
  };
  const result = parsed?.chart?.result?.[0];
  if (!result) {
    throw new Error(parsed?.chart?.error?.description ?? 'Yahoo chart response has no result');
  }
  const raw = result.indicators?.quote?.[0]?.close;
  if (!Array.isArray(raw)) throw new Error('Yahoo chart response has no close series');
  const closes: number[] = [];
  for (const c of raw) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) closes.push(c);
  }
  return closes;
}

async function fetchHistVolYahoo(symbol: string): Promise<HistVolResult> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const { text, proxied } = await fetchTextWithCorsFallback(url, 8000, (t) => t.trimStart().startsWith('{'));
  const closes = closesFromYahooChart(JSON.parse(text));
  const { vol, days } = annualizedVolFromCloses(closes);
  return { vol, days, source: proxied ? 'yahoo 1Y hist (proxied)' : 'yahoo 1Y hist' };
}

async function fetchHistVolStooq(symbol: string): Promise<HistVolResult> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(toStooqSymbol(symbol))}&i=d`;
  const { text, proxied } = await fetchTextWithCorsFallback(url, 8000, looksLikeCsv);
  const lines = text.trim().split('\n');
  // Date,Open,High,Low,Close,Volume
  const closes: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = Number(lines[i].split(',')[4]);
    if (Number.isFinite(c) && c > 0) closes.push(c);
  }
  const { vol, days } = annualizedVolFromCloses(closes);
  return {
    vol,
    days,
    source: proxied ? 'stooq 1Y hist (proxied)' : 'stooq 1Y hist',
  };
}

/** `symbol` is Yahoo-style (BA, ^SPX, BMW.DE). Yahoo chart endpoint first
 * (near-live daily closes), Stooq as backup — Stooq frequently serves an
 * HTML bot-challenge with HTTP 200 instead of CSV. */
export async function fetchHistVol(symbol: string): Promise<HistVolResult> {
  try {
    return await fetchHistVolYahoo(symbol);
  } catch (yahooErr) {
    const yahooMsg = yahooErr instanceof Error ? yahooErr.message : String(yahooErr);
    try {
      return await fetchHistVolStooq(symbol);
    } catch (stooqErr) {
      const stooqMsg = stooqErr instanceof Error ? stooqErr.message : String(stooqErr);
      throw new Error(
        `Vol history unavailable (yahoo: ${yahooMsg}; stooq: ${stooqMsg}) — enter vol manually`,
      );
    }
  }
}

export interface RefRateResult {
  /** Rate, decimal. */
  rate: number;
  asOf: string;
  source: string;
}

const ESTR_URL =
  'https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT?lastNObservations=1&format=csvdata';
const SOFR_URL = 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json';

/** Currencies with a keyless official reference-rate source. */
export const REF_RATE_CCYS = ['EUR', 'USD'] as const;

export async function fetchRefRate(currency: string): Promise<RefRateResult> {
  if (currency === 'EUR') {
    const { text, proxied } = await fetchTextWithCorsFallback(ESTR_URL, 8000);
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error('empty ECB response');
    const header = lines[0].split(',');
    const row = lines[1].split(',');
    const value = Number(row[header.indexOf('OBS_VALUE')]);
    const asOf = row[header.indexOf('TIME_PERIOD')];
    if (!Number.isFinite(value)) throw new Error('no €STR value');
    return { rate: value / 100, asOf, source: proxied ? 'ECB €STR (proxied)' : 'ECB €STR' };
  }
  if (currency === 'USD') {
    const { text, proxied } = await fetchTextWithCorsFallback(SOFR_URL, 8000);
    const data = JSON.parse(text) as {
      refRates?: { effectiveDate: string; percentRate: number }[];
    };
    const r = data.refRates?.[0];
    if (!r || !Number.isFinite(r.percentRate)) throw new Error('no SOFR value');
    return {
      rate: r.percentRate / 100,
      asOf: r.effectiveDate,
      source: proxied ? 'NY Fed SOFR (proxied)' : 'NY Fed SOFR',
    };
  }
  throw new Error(`No open reference-rate source for ${currency} — enter the rate manually`);
}
