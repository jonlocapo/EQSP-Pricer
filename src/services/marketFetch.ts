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

/** A single daily close paired with its Yahoo epoch-seconds timestamp. */
export interface DatedClose {
  t: number;
  close: number;
}

/**
 * Extracts the parallel (timestamp, close) series from a Yahoo chart-endpoint
 * JSON payload, dropping bars with a null/non-positive close (and their
 * matching timestamp) so the two arrays stay aligned.
 */
export function closesWithDatesFromYahooChart(json: unknown): DatedClose[] {
  const parsed = json as {
    chart?: {
      result?: {
        timestamp?: number[];
        indicators?: { quote?: { close?: (number | null)[] }[] };
      }[];
      error?: { description?: string } | null;
    };
  };
  const result = parsed?.chart?.result?.[0];
  if (!result) {
    throw new Error(parsed?.chart?.error?.description ?? 'Yahoo chart response has no result');
  }
  const raw = result.indicators?.quote?.[0]?.close;
  if (!Array.isArray(raw)) throw new Error('Yahoo chart response has no close series');
  const timestamps = result.timestamp;
  const out: DatedClose[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      // Fall back to the index when no timestamp array is present (some
      // callers, e.g. plain vol history, don't need real dates).
      const t = typeof timestamps?.[i] === 'number' ? timestamps[i] : i;
      out.push({ t, close: c });
    }
  }
  return out;
}

/** Extracts the daily close series from a Yahoo chart-endpoint JSON payload. */
export function closesFromYahooChart(json: unknown): number[] {
  return closesWithDatesFromYahooChart(json).map((d) => d.close);
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

/**
 * Fetches ~1Y of daily (timestamp, close) bars for a Yahoo-style symbol via
 * the same chart endpoint used for spot/hist-vol. Works for equities and FX
 * pairs alike (Yahoo serves FX crosses as `{BASE}{QUOTE}=X`).
 */
export async function fetchDailyCloses(yahooSymbol: string): Promise<DatedClose[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1y&interval=1d`;
  let text: string;
  try {
    ({ text } = await fetchTextWithCorsFallback(url, 8000, (t) => t.trimStart().startsWith('{')));
  } catch (e) {
    throw new Error(`Daily closes unavailable for "${yahooSymbol}": ${e instanceof Error ? e.message : 'fetch failed'}`);
  }
  const closes = closesWithDatesFromYahooChart(JSON.parse(text));
  if (closes.length === 0) throw new Error(`No daily closes returned for "${yahooSymbol}"`);
  return closes;
}

/** Buckets an epoch-seconds timestamp to its UTC calendar date (YYYY-MM-DD). */
function utcDateKey(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Pearson correlation of daily log-returns between two dated close series,
 * aligned by UTC calendar date (the two series may have different lengths
 * and different trading calendars — FX trades ~365 days/yr, equities fewer).
 * Throws if fewer than 30 overlapping days remain after alignment.
 */
export function realizedCorrelation(a: DatedClose[], b: DatedClose[]): number {
  const bByDate = new Map<string, number>();
  for (const d of b) bByDate.set(utcDateKey(d.t), d.close);

  const alignedA: number[] = [];
  const alignedB: number[] = [];
  for (const d of a) {
    const key = utcDateKey(d.t);
    const bClose = bByDate.get(key);
    if (bClose !== undefined) {
      alignedA.push(d.close);
      alignedB.push(bClose);
    }
  }
  if (alignedA.length < 31) {
    throw new Error('not enough overlapping history for correlation');
  }

  const retsA: number[] = [];
  const retsB: number[] = [];
  for (let i = 1; i < alignedA.length; i++) {
    retsA.push(Math.log(alignedA[i] / alignedA[i - 1]));
    retsB.push(Math.log(alignedB[i] / alignedB[i - 1]));
  }
  const meanA = retsA.reduce((x, y) => x + y, 0) / retsA.length;
  const meanB = retsB.reduce((x, y) => x + y, 0) / retsB.length;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < retsA.length; i++) {
    const da = retsA[i] - meanA;
    const db = retsB[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  const corr = cov / Math.sqrt(varA * varB);
  return Math.min(1, Math.max(-1, corr));
}

export interface FxRealizedResult {
  fxVol: number;
  corrEqFx: number;
  days: number;
  source: string;
}

/**
 * Realized FX vol and equity–FX correlation for a quanto note, from Yahoo
 * daily closes (~1Y). FX rate X is quoted as units of NOTE currency per 1
 * unit of UNDERLYING currency (`{UNDERLYING}{NOTE}=X`), matching the
 * riskNeutralDrift sign convention and the "FX quoted as note per underlying"
 * caption.
 */
export async function fetchFxRealizedVolAndCorr(
  underlyingCcy: string,
  noteCcy: string,
  equityTicker: string,
): Promise<FxRealizedResult> {
  const fxSymbol = `${underlyingCcy.toUpperCase()}${noteCcy.toUpperCase()}=X`;
  let fxCloses: DatedClose[];
  try {
    fxCloses = await fetchDailyCloses(fxSymbol);
  } catch (e) {
    throw new Error(`FX history unavailable for ${fxSymbol}: ${e instanceof Error ? e.message : 'fetch failed'}`);
  }
  const { vol: fxVol, days } = annualizedVolFromCloses(fxCloses.map((d) => d.close));

  let corrEqFx = 0;
  try {
    const eqCloses = await fetchDailyCloses(equityTicker);
    corrEqFx = realizedCorrelation(eqCloses, fxCloses);
  } catch (e) {
    throw new Error(
      `FX vol ok but correlation failed (${e instanceof Error ? e.message : 'failed'}) — corr left as entered`,
    );
  }

  return { fxVol, corrEqFx, days, source: 'yahoo 1Y realized' };
}
