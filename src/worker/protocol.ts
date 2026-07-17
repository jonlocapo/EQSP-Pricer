import type { PriceRequest, PriceResult } from '../model/request';

export type WorkerRequest =
  | { type: 'price'; payload: PriceRequest }
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
  | { type: 'error'; id: string; message: string }
  | { type: 'cancelled'; id: string };
