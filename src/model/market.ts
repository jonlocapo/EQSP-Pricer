/** Market data for pricing. All rates/vols are decimals (0.25 = 25%). */
export interface MarketData {
  /** Spot price of the underlying, absolute. */
  spot: number;
  /** Flat implied volatility, decimal. */
  vol: number;
  /** Continuously-compounded risk-free rate, decimal. */
  rate: number;
  /** Continuously-compounded dividend yield, decimal. */
  divYield: number;
  currency: string;
}

export const DEFAULT_MARKET: MarketData = {
  spot: 100,
  vol: 0.25,
  rate: 0.02,
  divYield: 0.02,
  currency: 'EUR',
};
