import type { PriceRequest, PriceResult } from '../model/request';
import type { PricingPhase, ProfileRequest, ProfileResult } from './protocol';

export interface ProgressUpdate {
  pathsDone: number;
  pathsTotal: number;
  phase: PricingPhase;
  solveIteration?: number;
}

/** Progress for a `profile` run: node-level (one of N+1 independent
 * pricings done), not path-level. */
export interface ProfileProgressUpdate {
  nodesDone: number;
  nodesTotal: number;
}

/**
 * Abstraction over the pricing engine. In phase 1 this is backed by
 * MockPricerClient; a real Web Worker-backed implementation arrives later
 * and can be swapped in via setPricerClient without touching UI code.
 */
export interface PricerClient {
  price(req: PriceRequest, onProgress: (p: ProgressUpdate) => void): Promise<PriceResult>;
  cancel(id: string): void;
  /** Chebyshev-interpolation price/greeks surrogate: prices N+1 Chebyshev
   * nodes in-worker (with common random numbers across nodes) and returns
   * the raw node samples; the caller builds the interpolant. */
  profile(req: ProfileRequest, onProgress: (p: ProfileProgressUpdate) => void): Promise<ProfileResult>;
}

// eslint-disable-next-line import/no-mutable-exports
export let pricerClient: PricerClient;

export function setPricerClient(c: PricerClient): void {
  pricerClient = c;
}
