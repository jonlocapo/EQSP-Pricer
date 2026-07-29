/**
 * Turns one option quote into a usable implied vol, preferring a vol
 * inverted from the observed PRICE (see engine/impliedVol) over whatever
 * implied vol a data provider published, and reporting the vol's own
 * UNCERTAINTY rather than pretending it is an exact point.
 *
 * WHY vega-scaled uncertainty, not a raw bid-ask spread ratio: a quote is a
 * bid AND an ask, not one number, so the vol it supports is an INTERVAL,
 * not a point. Its half-width is approximately
 *
 *     sigma_error ~= (ask - bid) / 2 / vega
 *
 * A raw spread ratio, (ask-bid)/mid, ignores vega entirely, so it treats
 * the SAME spread as equally informative on a 5-delta option and on an
 * at-the-money one. It is not: vega on a deep option is small, so a
 * one-dollar bid/ask window there implies an enormous vol uncertainty,
 * while the identical one-dollar window at the money, where vega is large,
 * pins the vol down tightly. A spread ratio cannot see that difference.
 * Vega-scaling can, and it is the real quantity a quote actually
 * constrains, so it replaces the cruder ratio outright rather than
 * supplementing it.
 */
import { bsCall, bsPut } from '../engine/blackScholes';
import { impliedVolFromPrice } from '../engine/impliedVol';

/** Shape-only: deliberately NOT importing OptionQuote from services/optionChain,
 * so this module stays a pure model-layer function of plain data. Any real
 * OptionQuote satisfies this structurally. */
export interface QuoteLike {
  bid?: number;
  ask?: number;
  last?: number;
  iv?: number;
}

export interface QuoteVol {
  vol: number;
  source: 'computed' | 'provider';
  /** Vega-scaled half-width of the vol interval this quote supports,
   * decimal vol points. Undefined when there was no two-sided market to
   * measure a spread from (a last-trade-only quote), or when the vol came
   * from the provider's own `iv` field, whose uncertainty this function has
   * no way to know. */
  uncertainty?: number;
}

/** A computed vol whose vega-scaled uncertainty exceeds this many vol
 * points does not pin down a volatility at all: at that point the bid and
 * ask are consistent with too wide a range of vols to be useful, so the
 * quote is dropped (falling back to the provider's iv, if any, or to
 * nothing) rather than fed into a surface. Roughly 2-3 vol points, per the
 * module doc. */
export const MAX_VOL_UNCERTAINTY = 0.03;

const MIN_PROVIDER_IV = 0.005;
const MAX_PROVIDER_IV = 3;

/** Central-difference vega with respect to (flat) vol, evaluated at the
 * already-solved vol. This is an ESTIMATE used only to size the
 * uncertainty band above, not a pricing input, so a simple bump is
 * appropriate; it does not need the analytic forward-space vega that
 * ./impliedVol's solver uses internally for speed. */
function bumpVega(s: number, k: number, t: number, vol: number, r: number, q: number, isCall: boolean): number {
  const h = 1e-4;
  const priceAt = (v: number) => (isCall ? bsCall(s, k, t, v, r, q) : bsPut(s, k, t, v, r, q));
  return (priceAt(vol + h) - priceAt(Math.max(1e-6, vol - h))) / (vol - Math.max(1e-6, vol - h) + h);
}

/**
 * Vol for one quote. Computed vol (inverted from the observed price) takes
 * priority over the provider's own `iv` field whenever it survives both
 * the no-arbitrage/time-value checks inside `impliedVolFromPrice` and the
 * uncertainty check here. Returns null when nothing usable survives.
 */
export function volFromQuote(
  q: QuoteLike,
  s: number,
  k: number,
  t: number,
  r: number,
  divYield: number,
  isCall: boolean,
): QuoteVol | null {
  const twoSided = q.bid !== undefined && q.ask !== undefined && q.bid > 0 && q.ask > 0 && q.ask >= q.bid;

  if (twoSided) {
    const bid = q.bid as number;
    const ask = q.ask as number;
    const mid = (bid + ask) / 2;
    const vol = impliedVolFromPrice({ price: mid, s, k, t, r, q: divYield, isCall });
    if (vol !== null) {
      const vega = bumpVega(s, k, t, vol, r, divYield, isCall);
      const uncertainty = vega > 1e-10 ? (ask - bid) / 2 / vega : Infinity;
      if (uncertainty <= MAX_VOL_UNCERTAINTY) {
        return { vol, source: 'computed', uncertainty };
      }
      // Too uncertain to trust: fall through to the provider fallback below,
      // exactly as if inversion had failed outright.
    }
  } else if (q.last !== undefined && q.last > 0) {
    // No two-sided market to measure a spread from, so there is no
    // uncertainty band to compute — accept the point estimate. Rejecting a
    // last-trade-only quote outright would throw away real information
    // just because it lacks a bid/ask, which is not the failure this
    // module exists to catch.
    const vol = impliedVolFromPrice({ price: q.last, s, k, t, r, q: divYield, isCall });
    if (vol !== null) return { vol, source: 'computed' };
  }

  if (q.iv !== undefined && q.iv > MIN_PROVIDER_IV && q.iv < MAX_PROVIDER_IV) {
    return { vol: q.iv, source: 'provider' };
  }
  return null;
}
