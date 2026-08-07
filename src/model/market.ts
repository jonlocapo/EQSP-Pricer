import type { VolSurface } from './volSurface';

/**
 * Quanto parameters for a cross-currency note. In this trade, the underlying
 * trades in one currency, but the payoff settles 1:1 in a different note
 * currency. Every payoff in this app is a function of performance S_T/S_0,
 * paid in the note currency. So any currency mismatch makes the note a quanto.
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
 * Costs a real issuer embeds. A textbook risk-neutral price ignores these
 * costs. The costs create the difference between a fair value and the level a
 * bank actually quotes. The model shows each cost explicitly, separate from
 * the price, instead of hiding it inside a fudged volatility.
 *
 * SIGNS MATTER. The costs do not all move the price the same way:
 *  - `fundingSpreadBp` makes a bank quote MORE generously, not less. A note is
 *    a funding instrument. The issuer discounts its own liability at its
 *    funding curve (rate + spread). This makes the bond component cheaper and
 *    frees cash to buy optionality. That is why a wide-funding issuer can pay
 *    a higher coupon.
 *  - `borrowCostBp` is a market CARRY input, not a desk charge. It lowers the
 *    forward. A lower forward raises the value of the put the investor is
 *    short, which lowers the note's value, and so RAISES the solved coupon
 *    (measured: +0.13 coupon points per 100bp on a 1y 60%-barrier note). To
 *    model a borrow charge that reduces the payable amount instead, use fee,
 *    not carry.
 *  - `feePct` is the distribution fee, the margin the bank retains. It reduces
 *    the value put into the structure. It is the main reason a bank's quote is
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
   * Present only for a cross-currency (quanto) note, where the underlying and
   * note currencies differ. Absent means a single-currency note: today's
   * behavior, with drift = rate − divYield. When present, drift uses the
   * quanto-adjusted risk-neutral measure (see riskNeutralDrift). Discounting
   * always stays at the note `rate`.
   */
  quanto?: QuantoParams;
  /**
   * Issuer and desk costs. Absent means a pure risk-neutral fair value,
   * today's behavior. This is still the right default for a theoretical
   * price.
   */
  costs?: CostParams;
  /**
   * Implied-vol surface built from a fetched option chain. When present, the
   * engine prices a product at the vol of ITS OWN risk strike (see
   * engine/riskStrike), instead of the flat `vol`. This matters because these
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

/** Note currencies the app can quote in. The app can source reference rates
 * only for EUR and USD; enter the rest by hand. Both the picker and the
 * "currency follows the underlying" logic share this list, so they cannot
 * drift apart. */
export const SUPPORTED_CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP', 'JPY'];

/**
 * Risk-neutral drift of the underlying under the note-currency measure.
 * Single-currency: mu = rate − divYield.
 * Quanto: mu = rateUnderlying − divYield − corrEqFx · vol · fxVol.
 * When set, the borrow cost acts like an extra dividend. It lowers the
 * forward, which raises the value of the puts these notes are short.
 * Discounting is unaffected here. See `discountRate`.
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
 * liability of the issuer. So the model discounts it on the issuer's curve
 * (risk-free + funding spread), not the risk-free curve. A wider spread
 * lowers the present value of the bond component. This is precisely the
 * funding benefit that lets an issuer pay a higher coupon.
 */
export function discountRate(m: MarketData): number {
  return m.rate + (m.costs?.fundingSpreadBp ?? 0) / 10_000;
}
