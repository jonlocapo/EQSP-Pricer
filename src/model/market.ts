import type { VolSurface } from './volSurface';

/**
 * Quanto parameters for a cross-currency note, i.e. a trade whose underlying
 * trades in one currency while the payoff settles 1:1 in a different note
 * currency. Every payoff in this app is a function of performance S_T/S_0
 * paid in the note currency, so any currency mismatch is a quanto.
 */
export interface QuantoParams {
  /** Underlying-currency risk-free rate, decimal. */
  rateUnderlying: number;
  /** FX vol (note ccy per underlying ccy), decimal. */
  fxVol: number;
  /** Corr(equity returns, FX returns), in [-1, 1]. */
  corrEqFx: number;
}

/**
 * Costs a real issuer embeds but a textbook risk-neutral price ignores. These
 * are the difference between a fair value and a level a bank actually quotes,
 * so they are modelled explicitly and shown separately rather than hidden in a
 * fudged volatility.
 *
 * SIGNS MATTER, and they do not all point the same way:
 *  - `fundingSpreadBp` makes a bank quote MORE generously, not less. A note is
 *    a funding instrument: the issuer discounts its own liability at its
 *    funding curve (rate + spread), which makes the bond component cheaper and
 *    frees cash to buy optionality — that is why a wide-funding issuer can pay
 *    a higher coupon.
 *  - `borrowCostBp` is a market CARRY input, not a desk charge: it lowers the
 *    forward, which makes the put the investor is short worth more, lowers the
 *    note's value, and so RAISES the solved coupon (measured: +0.13 coupon
 *    points per 100bp on a 1y 60%-barrier note). If you want a borrow charge
 *    that reduces what is payable instead, model it as fee, not as carry.
 *  - `feePct` is the distribution fee / margin the bank retains. It reduces the
 *    value put into the structure and is the dominant reason a bank's quote is
 *    less aggressive than fair value.
 */
export interface CostParams {
  /** Issuer funding spread over the risk-free rate, in basis points. */
  fundingSpreadBp: number;
  /** Stock borrow / repo cost in basis points, carried by the hedge. */
  borrowCostBp: number;
  /** Distribution fee / bank margin retained upfront, in % of notional. */
  feePct: number;
}

export const NO_COSTS: CostParams = { fundingSpreadBp: 0, borrowCostBp: 0, feePct: 0 };

/** Market data for pricing. All rates/vols are decimals (0.25 = 25%). */
export interface MarketData {
  /** Spot price of the underlying, absolute. */
  spot: number;
  /** Flat implied volatility, decimal. */
  vol: number;
  /** Continuously-compounded risk-free rate, decimal (note currency; used for discounting). */
  rate: number;
  /** Continuously-compounded dividend yield, decimal. */
  divYield: number;
  currency: string;
  /**
   * Present iff this is a cross-currency (quanto) note — underlying and note
   * currencies differ. Absent means single-currency: today's behavior,
   * drift = rate − divYield. When present, drift uses the quanto-adjusted
   * risk-neutral measure (see riskNeutralDrift); discounting always stays at
   * the note `rate`.
   */
  quanto?: QuantoParams;
  /**
   * Issuer/desk costs. Absent means a pure risk-neutral fair value — today's
   * behavior, and still the right default for a theoretical price.
   */
  costs?: CostParams;
  /**
   * Implied-vol surface built from a fetched option chain. When present the
   * engine prices a product at the vol of ITS OWN risk strike (see
   * engine/riskStrike) instead of the flat `vol`, which matters because these
   * payoffs live away from the money. Absent means flat-vol pricing.
   */
  volSurface?: VolSurface;
}

export const DEFAULT_MARKET: MarketData = {
  spot: 100,
  vol: 0.25,
  rate: 0.02,
  divYield: 0.02,
  currency: 'EUR',
};

/** Note currencies the app can quote in (it can only source reference rates
 * for EUR and USD; the rest must be entered by hand). Shared so the picker and
 * the "currency follows the underlying" logic can't drift apart. */
export const SUPPORTED_CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP', 'JPY'];

/**
 * Risk-neutral drift of the underlying under the note-currency measure.
 * Single-currency: mu = rate − divYield.
 * Quanto: mu = rateUnderlying − divYield − corrEqFx · vol · fxVol.
 * Borrow cost, when set, is carried like an extra dividend: it lowers the
 * forward, which makes the puts these notes are short more expensive.
 * Discounting is unaffected here — see `discountRate`.
 */
export function riskNeutralDrift(m: MarketData): number {
  const borrow = (m.costs?.borrowCostBp ?? 0) / 10_000;
  if (m.quanto) {
    return m.quanto.rateUnderlying - m.divYield - m.quanto.corrEqFx * m.vol * m.quanto.fxVol - borrow;
  }
  return m.rate - m.divYield - borrow;
}

/**
 * Rate used to discount the note's own cashflows. A note is a funded
 * liability of the issuer, so it is discounted on the issuer's curve
 * (risk-free + funding spread), not the risk-free curve. A wider spread lowers
 * the present value of the bond component, which is precisely the funding
 * benefit that lets an issuer pay a higher coupon.
 */
export function discountRate(m: MarketData): number {
  return m.rate + (m.costs?.fundingSpreadBp ?? 0) / 10_000;
}
