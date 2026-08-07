/**
 * Best-effort open-data market fetches beyond spot. Sources are free and
 * keyless, so they are limited:
 *  - Historical (realized) volatility from Stooq daily closes. This is a
 *    rough starting point for the vol input, NOT implied vol.
 *  - Official overnight reference rates: ECB €STR (EUR), NY Fed SOFR (USD),
 *    BoE SONIA (GBP, via FRED), SNB SARON (CHF), and BoJ TONA (JPY). These
 *    are daily fixings, not a live curve.
 * Everything here is a suggestion. Manual override always wins.
 */
import { fetchTextWithCorsFallback } from './spotFetch';
import { dailyReturnMoments, realizedTermStructure } from '../model/realizedSurface';
import { toStooqSymbol } from './symbols';
import { fetchDailyChart } from './ohlcFetch';

/** Stooq serves an HTML bot-challenge with HTTP 200 to some IPs. Treat any
 * non-CSV body as a failed attempt, so the proxy fallback kicks in. */
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
 * Extracts the parallel (timestamp, close) series from a Yahoo
 * chart-endpoint JSON payload. Drops bars with a null or non-positive
 * close, and their matching timestamp, so the two arrays stay aligned.
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
      // Fall back to the index when no timestamp array is present. Some
      // callers, for example plain vol history, do not need real dates.
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

/** `symbol` is Yahoo-style (BA, ^SPX, BMW.DE). Tries the Yahoo chart
 * endpoint first, for near-live daily closes, then Stooq as backup. Stooq
 * frequently serves an HTML bot-challenge with HTTP 200 instead of CSV. */
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
        `Vol history unavailable (yahoo: ${yahooMsg}; stooq: ${stooqMsg}). Enter vol manually.`,
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

export interface RateCurveResult {
  /** Zero-coupon rates, ascending by tYears. At least two points. */
  curve: { tYears: number; rate: number }[];
  asOf: string;
  source: string;
}

const ESTR_URL =
  'https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT?lastNObservations=1&format=csvdata';
const SOFR_URL = 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json';
/** FRED's keyless CSV endpoint, series IUDSOIA. This is the Bank of England
 * SONIA fixing, mirrored onto FRED, so it needs no BoE-specific parsing. */
const SONIA_SERIES = 'IUDSOIA';
/** SNB data portal cube for the SARON daily fixing at the close of the
 * trading day. This cube always answers with the last 5 observations, so
 * the request needs no date filter. */
const SARON_URL = 'https://data.snb.ch/api/cube/snbgwdzid/data/json/en?dimSel=D0(SARON)';
/** BoJ Time-Series Data Search API. DB FM01 is the Uncollateralized
 * Overnight Call Rate; series STRDCLUCON is the daily average, which is
 * TONA (also called TONAR). */
const TONA_SERIES_CODE = 'STRDCLUCON';

/** Days since epoch shifted back by `days`, as an ISO calendar date
 * (YYYY-MM-DD). Used to bound the FRED CSV request to a small recent
 * window instead of pulling the full multi-decade history. */
function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Days since epoch shifted back by `days`, as a BoJ-style YYYYMM start
 * date. The BoJ API takes daily series start dates in monthly granularity,
 * so a request from a month ago safely covers the recent fixings even
 * across a long holiday gap. */
function bojStartDateYYYYMM(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Parses the FRED fredgraph.csv body for a single-series request into the
 * latest (date, decimal rate) pair. FRED marks a missing observation with
 * "." rather than a number, so the loop walks backward and skips any row
 * that does not parse as a finite number. This picks the most recent real
 * fixing instead of a missing-value placeholder.
 */
export function parseFredLatestPercent(text: string): { asOf: string; ratePercent: number } {
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('empty FRED response');
  let latest: { asOf: string; ratePercent: number } | null = null;
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i].split(',');
    const value = Number(raw);
    if (date && Number.isFinite(value)) latest = { asOf: date, ratePercent: value };
  }
  if (!latest) throw new Error('no numeric observation in FRED response');
  return latest;
}

/**
 * Parses the SNB data-portal JSON body for the SARON cube into the latest
 * (date, decimal rate) pair. The cube already answers with only the most
 * recent observations, so the last entry in the array is the latest one.
 */
export function parseSnbSaron(text: string): { asOf: string; ratePercent: number } {
  const data = JSON.parse(text) as {
    timeseries?: { values?: { date: string; value: number }[] }[];
  };
  const values = data.timeseries?.[0]?.values ?? [];
  const last = values[values.length - 1];
  if (!last || !Number.isFinite(last.value)) throw new Error('no SARON value in SNB response');
  return { asOf: last.date, ratePercent: last.value };
}

/**
 * Parses the BoJ Time-Series Data Search JSON body for the FM01
 * uncollateralized overnight call rate series into the latest (date,
 * decimal rate) pair. Weekend and holiday rows come back as `null`, so the
 * loop walks the parallel date/value arrays and keeps the last finite one.
 */
export function parseBojTona(text: string): { asOf: string; ratePercent: number } {
  const data = JSON.parse(text) as {
    RESULTSET?: { VALUES?: { SURVEY_DATES?: number[]; VALUES?: (number | null)[] } }[];
  };
  const series = data.RESULTSET?.[0]?.VALUES;
  const dates = series?.SURVEY_DATES ?? [];
  const rates = series?.VALUES ?? [];
  let latest: { asOf: number; ratePercent: number } | null = null;
  for (let i = 0; i < rates.length; i++) {
    const v = rates[i];
    if (typeof v === 'number' && Number.isFinite(v)) latest = { asOf: dates[i], ratePercent: v };
  }
  if (!latest) throw new Error('no TONA value in BoJ response');
  const digits = String(latest.asOf);
  const asOf = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return { asOf, ratePercent: latest.ratePercent };
}

/** Currencies with a keyless official reference-rate source. */
export const REF_RATE_CCYS = ['EUR', 'USD', 'GBP', 'CHF', 'JPY'] as const;

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
  if (currency === 'GBP') {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${SONIA_SERIES}&cosd=${isoDateDaysAgo(20)}`;
    const { text, proxied } = await fetchTextWithCorsFallback(url, 8000, looksLikeCsv);
    const { asOf, ratePercent } = parseFredLatestPercent(text);
    return { rate: ratePercent / 100, asOf, source: proxied ? 'BoE SONIA (proxied)' : 'BoE SONIA' };
  }
  if (currency === 'CHF') {
    const { text, proxied } = await fetchTextWithCorsFallback(SARON_URL, 8000, (t) => t.trimStart().startsWith('{'));
    const { asOf, ratePercent } = parseSnbSaron(text);
    return { rate: ratePercent / 100, asOf, source: proxied ? 'SNB SARON (proxied)' : 'SNB SARON' };
  }
  if (currency === 'JPY') {
    const url =
      `https://www.stat-search.boj.or.jp/api/v1/getDataCode?format=json&lang=en&db=FM01` +
      `&code=${TONA_SERIES_CODE}&startDate=${bojStartDateYYYYMM(35)}`;
    const { text, proxied } = await fetchTextWithCorsFallback(url, 8000, (t) => t.trimStart().startsWith('{'));
    const { asOf, ratePercent } = parseBojTona(text);
    return { rate: ratePercent / 100, asOf, source: proxied ? 'BoJ TONA (proxied)' : 'BoJ TONA' };
  }
  throw new Error(`No open reference-rate source for ${currency}. Enter the rate manually.`);
}

/** Zero-coupon curve points, per currency, keyed by the ECB SDW series
 * suffix for EUR and the FRED series id for USD. Currencies without a
 * keyless multi-tenor curve (GBP, CHF, JPY) keep the flat overnight rate —
 * see `fetchRateCurve`'s doc. */
const RATE_CURVE_SOURCES: Record<
  string,
  { kind: 'ecb' | 'fred'; keys: string[]; tenorsYears: number[] }
> = {
  EUR: {
    kind: 'ecb',
    // ECB euro-area zero-coupon yield curve (4F = government-guaranteed
    // AAA), the natural continuation of the €STR fixing the flat path uses.
    keys: ['ZR_3M', 'ZR_1Y', 'ZR_2Y', 'ZR_5Y'],
    tenorsYears: [0.25, 1, 2, 5],
  },
  USD: {
    kind: 'fred',
    // FRED Treasury constant-maturity par yields. Not OIS: a proxy for the
    // risk-free curve, bootstrapped to zero rates below and labelled as
    // such in the UI.
    keys: ['DGS3MO', 'DGS1', 'DGS2', 'DGS5'],
    tenorsYears: [0.25, 1, 2, 5],
  },
};

/** Parses one ECB SDW CSV body into the latest (asOf, ratePercent) pair.
 * SDW csvdata rows are `TIME_PERIOD,OBS_VALUE`. */
function parseEcbLatest(text: string): { asOf: string; ratePercent: number } {
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('empty ECB response');
  const header = lines[0].split(',');
  const obsIdx = header.indexOf('OBS_VALUE');
  const timeIdx = header.indexOf('TIME_PERIOD');
  if (obsIdx < 0 || timeIdx < 0) throw new Error('unexpected ECB CSV shape');
  const row = lines[lines.length - 1].split(',');
  const value = Number(row[obsIdx]);
  if (!Number.isFinite(value)) throw new Error('no numeric observation in ECB response');
  return { asOf: row[timeIdx], ratePercent: value };
}

/**
 * Bootstraps annual-par yields to continuously-compounded zero rates.
 *
 * A par yield c(T) is the coupon that prices a bond at par; it is NOT the
 * zero rate at T unless the curve is flat. With annual coupons, the zero
 * rate z(T) solves
 *
 *   sum_{j=1}^{T} c(T) * exp(-z(j) * j) + exp(-z(T) * T) = 1
 *
 * which this function walks out in maturity order, reusing the already-
 * known earlier zeros. Non-integer tenors (3M) bootstrap from the
 * short zero directly, an approximation that keeps the code simple and the
 * direction honest: on an upward curve the par yield UNDERSTATES the zero
 * rate, and the bootstrap restores most of the difference.
 */
function parToZero(par: { tYears: number; rate: number }[]): { tYears: number; rate: number }[] {
  const out: { tYears: number; rate: number }[] = [];
  for (const p of par) {
    if (p.tYears <= 1) {
      // No coupon period inside the horizon (3M) or exactly one annual
      // coupon (1Y). For T <= 1: exp(z*T) = 1 + c*T, so the zero rate is
      // z = ln(1 + c*T)/T, which is ln(1+c) at T = 1 — consistent.
      out.push({ tYears: p.tYears, rate: Math.log(1 + p.rate * p.tYears) / p.tYears });
      continue;
    }
    const T = p.tYears;
    const c = p.rate;
    let sumPv = 0;
    for (const prev of out) {
      const j = prev.tYears;
      if (j >= T) break;
      sumPv += c * Math.exp(-prev.rate * j);
    }
    const z = -Math.log((1 - sumPv) / (1 + c)) / T;
    out.push({ tYears: T, rate: z });
  }
  return out;
}

/**
 * A zero-coupon rate curve at 3M/1Y/2Y/5Y for the note currency, from
 * keyless official sources: ECB SDW (EUR zero curve) and FRED constant
 * maturities (USD, bootstrapped). GBP, CHF and JPY have no free
 * multi-tenor source, so they keep the flat overnight rate — the
 * overnight-fixing caveat the curve exists to fix applies to them and the
 * model reports it as flat pricing.
 *
 * The 3M/1Y/2Y/5Y points are clamped into a sane band before returning:
 * a bad observation must not print a nonsense curve into the engine.
 * Throws for currencies with no curve source; callers fall back to flat.
 */
export async function fetchRateCurve(currency: string): Promise<RateCurveResult> {
  const src = RATE_CURVE_SOURCES[currency];
  if (!src) {
    throw new Error(`No open rate-curve source for ${currency}. Rates stay flat.`);
  }
  const clamp = (r: number) => Math.min(0.15, Math.max(-0.05, r));
  let asOf = '';
  if (src.kind === 'ecb') {
    const points = await Promise.all(
      src.keys.map(async (key, i) => {
        const url = `https://data-api.ecb.europa.eu/service/data/YC.B.U2.EUR.4F.G_N_A.SV_C_YM.${key}?lastNObservations=1&format=csvdata`;
        const { text } = await fetchTextWithCorsFallback(url, 8000);
        const { asOf: a, ratePercent } = parseEcbLatest(text);
        asOf = a;
        return { tYears: src.tenorsYears[i], rate: clamp(ratePercent / 100) };
      }),
    );
    return { curve: points, asOf, source: 'ECB zero curve' };
  }
  // USD: FRED constant-maturity par yields, bootstrapped to zeros.
  const par = await Promise.all(
    src.keys.map(async (id, i) => {
      const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${isoDateDaysAgo(40)}`;
      const { text } = await fetchTextWithCorsFallback(url, 8000, looksLikeCsv);
      const { asOf: a, ratePercent } = parseFredLatestPercent(text);
      asOf = a;
      return { tYears: src.tenorsYears[i], rate: clamp(ratePercent / 100) };
    }),
  );
  const curve = parToZero(par);
  return { curve, asOf, source: 'FRED CMT bootstrapped' };
}

/**
 * Fetches about 1 year of daily (timestamp, close) bars for a Yahoo-style
 * symbol, via the same chart endpoint used for spot and hist-vol. Works for
 * equities and FX pairs alike; Yahoo serves FX crosses as
 * `{BASE}{QUOTE}=X`.
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
 * aligned by UTC calendar date. The two series may have different lengths
 * and different trading calendars; FX trades about 365 days a year,
 * equities fewer. Throws if fewer than 30 overlapping days remain after
 * alignment.
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
 * Realized FX vol and equity-FX correlation for a quanto note, from Yahoo
 * daily closes, about 1 year. FX rate X is quoted as units of NOTE
 * currency per 1 unit of UNDERLYING currency (`{UNDERLYING}{NOTE}=X`).
 * This matches the riskNeutralDrift sign convention and the "FX quoted as
 * note per underlying" caption.
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
      `FX vol ok but correlation failed (${e instanceof Error ? e.message : 'failed'}). Correlation left as entered.`,
    );
  }

  return { fxVol, corrEqFx, days, source: 'yahoo 1Y realized' };
}

/**
 * Realized volatility term structure and return moments from daily closes.
 *
 * This is the self-sufficient path for volatility: it needs only the daily
 * chart endpoint, which fetches dependably, unlike option chains. Feed the
 * result to buildRealizedSurface (model/realizedSurface.ts) to get a surface
 * with a measured term structure and a measured skew, instead of a single flat
 * number.
 */
export interface RealizedStatsResult {
  terms: { tYears: number; vol: number }[];
  skewDaily: number;
  excessKurtDaily: number;
  /** Annualized vol over the longest available window — the headline figure. */
  vol: number;
  days: number;
  source: string;
  /** The raw chart response this was built from.
   *
   * The dividend yield is measured from the ADJUSTED close, which rides in
   * this same payload (see ../model/divYield). Carrying it back means the
   * measurement does not care WHICH realized estimator ran: the OHLC path
   * (fetchRealizedVolStats) and this close-only fallback both hand the
   * caller a payload, so the dividend never triggers a second, identical
   * request to the rate-limited chart endpoint. This uses the shared
   * `fetchDailyChart` (two years, `events=div`, adjusted close) rather than
   * the close-only fetch, which has none of the three.
   */
  payload: unknown;
}

export async function fetchRealizedStats(yahooSymbol: string): Promise<RealizedStatsResult> {
  const { bars, payload } = await fetchDailyChart(yahooSymbol);
  const px = bars.map((b) => b.close);
  if (px.length < 30) {
    throw new Error(`Only ${px.length} closes for "${yahooSymbol}", not enough for a vol estimate`);
  }
  const logReturns: number[] = [];
  for (let i = 1; i < px.length; i++) logReturns.push(Math.log(px[i] / px[i - 1]));

  const { skewDaily, excessKurtDaily } = dailyReturnMoments(logReturns);
  const terms = realizedTermStructure(logReturns);
  if (terms.length === 0) {
    throw new Error(`Not enough history for a realized vol term structure on "${yahooSymbol}"`);
  }
  return {
    terms,
    skewDaily,
    excessKurtDaily,
    vol: terms[terms.length - 1].vol,
    days: logReturns.length,
    source: 'yahoo close-to-close realized',
    payload,
  };
}
