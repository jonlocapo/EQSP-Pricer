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
}

export const DEFAULT_MARKET: MarketData = {
  spot: 100,
  vol: 0.25,
  rate: 0.02,
  divYield: 0.02,
  currency: 'EUR',
};

/**
 * Risk-neutral drift of the underlying under the note-currency measure.
 * Single-currency: mu = rate − divYield.
 * Quanto: mu = rateUnderlying − divYield − corrEqFx · vol · fxVol.
 * Discounting is unaffected — it always uses the note `rate`.
 */
export function riskNeutralDrift(m: MarketData): number {
  if (m.quanto) {
    return m.quanto.rateUnderlying - m.divYield - m.quanto.corrEqFx * m.vol * m.quanto.fxVol;
  }
  return m.rate - m.divYield;
}
