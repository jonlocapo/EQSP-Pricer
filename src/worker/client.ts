import type { PriceRequest, PriceResult } from '../model/request';
import type { PricingPhase } from './protocol';

export interface ProgressUpdate {
  pathsDone: number;
  pathsTotal: number;
  phase: PricingPhase;
  solveIteration?: number;
}

/**
 * Abstraction over the pricing engine. In phase 1 this is backed by
 * MockPricerClient; a real Web Worker-backed implementation arrives later
 * and can be swapped in via setPricerClient without touching UI code.
 */
export interface PricerClient {
  price(req: PriceRequest, onProgress: (p: ProgressUpdate) => void): Promise<PriceResult>;
  cancel(id: string): void;
}

// eslint-disable-next-line import/no-mutable-exports
export let pricerClient: PricerClient;

export function setPricerClient(c: PricerClient): void {
  pricerClient = c;
}
