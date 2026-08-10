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

/** One point of a zero-coupon rate curve: continuously-compounded rate at a
 * maturity. Rates are decimals (0.02 = 2%). */
export interface RatePoint {
  tYears: number;
  rate: number;
}

/**
 * One leg of a worst-of basket.
 *
 * Deliberately NOT carrying a spot. Every payoff here reads relative
 * performance `S(t)/S(0)`, so a leg's starting level cancels and cannot move a
 * price. Storing it would be a field nothing reads, and the panel keeps the
 * quoted levels for display on its own.
 */
export interface BasketAsset {
  /** Implied volatility this leg simulates at, decimal. Flat over the life.
   * `effectiveMarketFor` overwrites it with the leg's own volatility at the
   * product's risk strike when `volSurface` is present. */
  vol: number;
  /** Continuously-compounded dividend yield for this leg, decimal. */
  divYield: number;
  /**
   * This leg's OWN volatility surface, when a fetch measured one.
   *
   * A worst-of knocks in on the worst leg, so every leg is short a
   * down-and-in put, and every leg must price at the volatility of the
   * knock-in strike rather than the at-the-money volatility. One shared
   * surface cannot do that: leg two's skew is not leg one's.
   *
   * `effectiveMarketFor` reads each surface at the risk strike and collapses
   * it into `vol` above. The engine never sees this field, so the path cache
   * key stays small and still keys on the volatility that actually priced
   * the note.
   */
  volSurface?: VolSurface;
  /**
   * This leg's term structure: one volatility per grid step, at the risk
   * strike. Set by `effectiveMarketFor` when the leg's surface has a term
   * structure, absent when it does not.
   *
   * A basket leg needs its own schedule for the same reason a single name
   * does. A 5-year autocall that can call in year one must simulate year one
   * on year-one volatility, not on the 5-year number. Two legs of a basket
   * rarely share a term structure, so one shared schedule would be the wrong
   * curve for at least one of them.
   *
   * Length equals the grid step count. `MarketData.volPerStep` stays absent
   * for a basket: that field describes a single asset, and the basket path
   * builder rejects it.
   */
  volPerStep?: number[];
}

/**
 * A worst-of basket. Present only when the product has two or more
 * underlyings.
 *
 * The engine simulates each leg's PERFORMANCE and hands the payoff the worst
 * of them at each step (see engine/gbm.ts). That collapse is exact for a
 * worst-of, because no worst-of payoff asks WHICH leg is worst, only how far
 * down it is.
 *
 * `correlation` must be a valid correlation matrix: square, unit diagonal,
 * positive semi-definite. Repair it with `repairCorrelation` before it reaches
 * here, because a non-PSD matrix has no Cholesky factor and cannot be
 * simulated at all.
 */
export interface BasketParams {
  /** One entry per underlying, in the same order as `spec.underlyings`. */
  assets: BasketAsset[];
  /** `correlation[i][j]` between legs i and j. */
  correlation: number[][];
}

/** Market data for pricing. All rates/vols are decimals (0.25 = 25%). */
export interface MarketData {
  /** Spot price of the underlying, absolute. */
  spot: number;
  /** Flat implied volatility, decimal. */
  vol: number;
  /** Continuously-compounded risk-free rate, decimal (note currency; used for discounting). */
  rate: number;
  /**
   * Zero-coupon rate curve for the note currency, ascending by tYears. When
   * present, discounting uses the curve's interpolated rate at each cashflow
   * date (see engine/discount.ts's `rateAt`), and the path drift uses the
   * forward rate of each simulation step, instead of one overnight fixing
   * applied flat to every tenor — a 5-year capital-guaranteed note's bond
   * floor is most of its price, and the overnight rate is increasingly wrong
   * there. Absent means the flat `rate` for the whole life, today's
   * behavior. Never set for the underlying currency of a quanto note: the
   * quanto drift keeps the flat `rateUnderlying`.
   */
  rateCurve?: RatePoint[];
  /** Continuously-compounded dividend yield, decimal. */
  divYield: number;
  /**
   * Worst-of basket legs and their correlations. Absent, or shorter than two
   * entries, means a single underlying and today's behavior exactly: the
   * engine keeps the scalar `vol` and `divYield` and never enters the basket
   * branch, so single-asset paths stay bit-identical.
   *
   * `vol` and `divYield` above remain the FIRST leg's values, so anything that
   * reads them without knowing about baskets still sees a sensible number
   * rather than a stale one.
   */
  basket?: BasketParams;
  currency: string;
  /**
   * Per-step piecewise-constant volatility, decimal, length nSteps, one
   * entry per simulation step. Absent means the flat `vol` for the whole
   * life, today's behavior. Present means the path's diffusion uses
   * `volPerStep[i]` on step i, so a multi-step product can be simulated on
   * the vol of ITS OWN step horizon instead of one vol taken at the final
   * tenor — a 5-year autocall that may call in year one no longer runs the
   * whole path on 5-year vol. Built by `effectiveMarketFor` (see
   * worker/pricing.ts) from the vol surface's term structure at the
   * product's risk strike, total-variance preserving per step (a step's
   * vol^2 * dt equals the surface's forward total variance over that step),
   * which makes it exact, not an approximation, and identical to the flat
   * case when the surface has no term structure. The quanto drift's
   * equity-FX correlation term deliberately keeps the single `vol` — it is
   * a cross-asset covariance anchor, held constant per step.
   */
  volPerStep?: number[];
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
