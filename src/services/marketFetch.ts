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

export async function fetchHistVol(symbol: string): Promise<HistVolResult> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
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
