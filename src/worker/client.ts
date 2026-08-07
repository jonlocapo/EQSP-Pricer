import type { PriceRequest, PriceResult } from '../model/request';
import type { PricingPhase } from './protocol';

export interface ProgressUpdate {
  pathsDone: number;
  pathsTotal: number;
  phase: PricingPhase;
  solveIteration?: number;
}

/**
 * Abstraction over the pricing engine. The real Web Worker-backed client
 * (`WorkerPricerClient`, installed in main.tsx) is the only implementation;
 * the interface exists so tests and tooling can swap in a fake without
 * touching UI code.
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
