import type { MarketData } from '../model/market';
import type { ProductSpec } from '../model/product';
import type { McSettings, PriceRequest, PriceResult } from '../model/request';

/**
 * Request for a Chebyshev-interpolation price/greeks surrogate: prices
 * `product` at N+1 Chebyshev-Lobatto nodes spanning
 * [market.spot*(1-rangeFrac), market.spot*(1+rangeFrac)], all nodes sharing
 * the SAME mc.seed/numPaths/antithetic (common random numbers) so PV(spot)
 * comes out smooth enough to differentiate analytically. N defaults to 32
 * (33 nodes), rangeFrac defaults to 0.5.
 */
export interface ProfileRequest {
  id: string;
  product: ProductSpec;
  market: MarketData;
  mc: McSettings;
  N?: number;
  rangeFrac?: number;
}

export interface ProfileNode {
  spot: number;
  pvPct: number;
  stderrPct: number;
}

export interface ProfileResult {
  id: string;
  /** Chebyshev-Lobatto k=0..N order (nodes[0].spot = spotHi, nodes[N].spot = spotLo). */
  nodes: ProfileNode[];
  spotLo: number;
  spotHi: number;
  N: number;
}

export type WorkerRequest =
  | { type: 'price'; payload: PriceRequest }
  | { type: 'profile'; payload: ProfileRequest }
  | { type: 'cancel'; id: string };

export type PricingPhase = 'pricing' | 'solving' | 'greeks';

export type WorkerResponse =
  | {
      type: 'progress';
      id: string;
      pathsDone: number;
      pathsTotal: number;
      phase: PricingPhase;
      solveIteration?: number;
    }
  | { type: 'result'; id: string; result: PriceResult }
  | { type: 'profileProgress'; id: string; nodesDone: number; nodesTotal: number }
  | { type: 'profileResult'; id: string; result: ProfileResult }
  | { type: 'error'; id: string; message: string }
  | { type: 'cancelled'; id: string };
