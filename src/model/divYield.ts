/**
 * Dividend yield measured from PRICE HISTORY, with no option chain.
 *
 * WHY: the yield enters the risk-neutral drift as `rate - divYield - borrow`,
 * so it moves the forward and therefore every price. Until now it came only
 * from put-call parity on an option chain (see impliedFromChain), which means
 * that with no chain reachable it simply stayed at whatever the user had typed.
 * A stale yield is not a cosmetic problem: on a 5 year note a 2% error in the
 * yield compounds into a large error in the forward.
 *
 * HOW: a total-return series and a price-return series over the same window
 * differ by exactly the dividends. So the continuously compounded yield is the
 * gap between their log returns, annualized:
 *
 *     q = [ ln(total_T / total_0) - ln(price_T / price_0) ] / T
 *
 * For a single stock or an ETF the total-return series is the ADJUSTED close,
 * which reinvests dividends, and the price series is the raw close. Both are
 * split-adjusted by the same factor, so splits cancel in the ratio and need no
 * separate handling.
 *
 * WHAT THIS IS NOT: a forward-looking yield. It is the yield the underlying
 * actually paid over the window. A trailing measure misses an announced but
 * unpaid change to the dividend, and it will lag a cut or a special dividend.
 * Label it as realized wherever it reaches the user, and let a manual override
 * win.
 */

/** Trading days per year, matching the engine's simulation frequency. */
const DAYS_PER_YEAR = 252;

/**
 * A yield beyond this is treated as a DATA fault rather than a real dividend.
 * Very high payers exist, but a measured 60% is far more likely to be a
 * mis-scaled or mis-aligned series, and silently accepting it would corrupt the
 * drift. So the caller is told to fall back instead.
 */
const MAX_PLAUSIBLE_YIELD = 0.5;

/**
 * A slightly negative reading is rounding, not a negative dividend, and is
 * flattened to zero. Anything more negative than this means the two series do
 * not correspond, so it is rejected rather than flattened.
 */
const MIN_TOLERATED_YIELD = -0.02;

export interface RealizedDivYieldResult {
  /** Continuously compounded annual yield, decimal. */
  divYield: number;
  /** Years the measurement spans. */
  years: number;
  /** Aligned observation count. */
  days: number;
}

/**
 * The realized dividend yield from a total-return series and a price series.
 *
 * The two arrays must be parallel and the same length: element i of each must
 * describe the same trading day. Pairs where either value is missing or
 * non-positive are dropped TOGETHER, so the series stay aligned.
 */
export function realizedDivYield(totalReturn: number[], price: number[]): RealizedDivYieldResult {
  if (totalReturn.length !== price.length) {
    throw new Error('Total-return and price series must be the same length');
  }
  const tr: number[] = [];
  const px: number[] = [];
  for (let i = 0; i < price.length; i++) {
    const a = totalReturn[i];
    const b = price[i];
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
      tr.push(a);
      px.push(b);
    }
  }
  // Two points give a yield, but over a handful of days a single dividend
  // dominates and annualizing it is meaningless. Require a real window.
  if (tr.length < 60) {
    throw new Error(`Only ${tr.length} usable bars for a dividend yield, need 60`);
  }
  const years = (tr.length - 1) / DAYS_PER_YEAR;
  if (!(years > 0)) throw new Error('Dividend yield needs a positive window');

  const totalLogReturn = Math.log(tr[tr.length - 1] / tr[0]);
  const priceLogReturn = Math.log(px[px.length - 1] / px[0]);
  const raw = (totalLogReturn - priceLogReturn) / years;

  if (!Number.isFinite(raw)) throw new Error('Dividend yield came out non-finite');
  if (raw > MAX_PLAUSIBLE_YIELD) {
    throw new Error(`Measured dividend yield ${(raw * 100).toFixed(1)}% is implausible; series may be mismatched`);
  }
  if (raw < MIN_TOLERATED_YIELD) {
    throw new Error(
      `Measured dividend yield ${(raw * 100).toFixed(1)}% is negative; the two series do not correspond`,
    );
  }
  return { divYield: Math.max(0, raw), years, days: tr.length };
}
