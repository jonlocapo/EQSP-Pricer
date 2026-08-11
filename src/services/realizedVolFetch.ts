/**
 * This underlying's realized volatility statistics, built from daily OHLC
 * bars: the Yang-Zhang estimator (`../model/volEstimators.ts`) for the
 * variance LEVEL, and a GJR-GARCH(1,1) term structure (`../model/garch.ts`)
 * for the maturity SHAPE, in place of `../model/realizedSurface.ts`'s four
 * overlapping trailing windows.
 *
 * WHY a separate file from `./marketFetch.ts`: that file already has a
 * close-only `fetchRealizedStats` and other changes in flight, and must
 * not be touched here. This module owns the OHLC-based path end to end —
 * fetch bars (`./ohlcFetch.ts`), pick an estimator, fit a variance model —
 * and returns a result shaped so `./volPipeline.ts` can feed it straight
 * into `buildRealizedSurface`, exactly like the close-only path did.
 */
import { fetchDailyChart } from './ohlcFetch';
import { yangZhangVar } from '../model/volEstimators';
import { dailyReturnMoments, realizedTermStructure } from '../model/realizedSurface';
import { garchTermStructure } from '../model/garch';

export interface RealizedVolStatsResult {
  terms: { tYears: number; vol: number }[];
  skewDaily: number;
  excessKurtDaily: number;
  /** Annualized vol over the longest available term — the headline figure. */
  vol: number;
  days: number;
  source: string;
  /** Which estimator gave the level and which model gave the term-structure
   * shape, for the UI, e.g. "Yang-Zhang + GJR-GARCH(1,1)". */
  modelLabel: string;
  /** The raw chart response this was built from.
   *
   * The dividend yield is measured from the ADJUSTED close, which rides in this
   * same payload (see ../model/divYield). Handing it back lets the caller
   * measure the yield without spending a second identical request, which
   * matters because Yahoo rate-limits per IP and one Fetch press already makes
   * several calls. */
  payload: unknown;
}

/** Horizons the term structure is tabulated at, matching
 * `realizedTermStructure`'s default trailing windows so a surface built
 * from either path looks the same shape of the answer. */
const HORIZONS_DAYS = [21, 63, 126, 252];

/** Below this many bars, a GJR-GARCH(1,1) fit has too few return observations
 * to trust (see `../model/garch.ts`'s own MIN_OBS_FOR_FIT), so this falls
 * back to the trailing-window term structure — the same one the close-only
 * path already uses and that `realizedSurface.test.ts` pins. */
const MIN_BARS_FOR_GARCH = 90;

/** Below this many bars there is not enough history for any vol estimate,
 * range-based or not — matches `fetchRealizedStats`'s own floor. */
const MIN_BARS = 30;

export async function fetchRealizedVolStats(yahooSymbol: string): Promise<RealizedVolStatsResult> {
  const { bars, payload } = await fetchDailyChart(yahooSymbol);
  if (bars.length < MIN_BARS) {
    throw new Error(`Only ${bars.length} OHLC bars for "${yahooSymbol}", not enough for a vol estimate`);
  }

  const logReturns: number[] = [];
  for (let i = 1; i < bars.length; i++) logReturns.push(Math.log(bars[i].close / bars[i - 1].close));

  const { skewDaily, excessKurtDaily } = dailyReturnMoments(logReturns);

  if (bars.length < MIN_BARS_FOR_GARCH) {
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
      source: 'yahoo OHLC (trailing windows: too few bars for GARCH)',
      modelLabel: 'close-to-close (trailing windows)',
      payload,
    };
  }

  // The GJR long-run level is anchored on Yang-Zhang, not on the sample
  // variance of close-to-close returns GARCH would otherwise default to
  // (see fitGjr's `targetVar`) — the whole point of leading with the
  // more efficient range-based estimator.
  const targetVar = yangZhangVar(bars);
  const { terms, converged } = garchTermStructure(logReturns, HORIZONS_DAYS, targetVar);
  const usableTerms = terms.length > 0 ? terms : realizedTermStructure(logReturns);
  if (usableTerms.length === 0) {
    throw new Error(`Not enough history for a realized vol term structure on "${yahooSymbol}"`);
  }

  return {
    terms: usableTerms,
    skewDaily,
    excessKurtDaily,
    vol: usableTerms[usableTerms.length - 1].vol,
    days: logReturns.length,
    source: 'yahoo OHLC realized',
    // NOT "flat". The unconverged branch reverts the short-term EWMA level
    // toward the Yang-Zhang anchor passed above as `targetVar`, so a shocked
    // short vol decays over the term rather than being held out to a year.
    // The old label still said "flat" from before that fix, which reads as
    // "this number is the Nestle bug" and sent a real investigation down the
    // wrong path.
    modelLabel: converged
      ? 'Yang-Zhang + GJR-GARCH(1,1)'
      : 'Yang-Zhang + EWMA reverting to the Yang-Zhang anchor',
    payload,
  };
}
