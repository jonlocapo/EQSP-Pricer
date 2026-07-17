import type { PriceRequest, PriceResult } from '../model/request';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { PricerClient, ProgressUpdate } from './client';

interface Pending {
  resolve: (r: PriceResult) => void;
  reject: (e: Error) => void;
  onProgress: (p: ProgressUpdate) => void;
}

/** PricerClient backed by the Monte Carlo Web Worker. */
export class WorkerPricerClient implements PricerClient {
  private worker: Worker;
  private pending = new Map<string, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./pricer.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      switch (msg.type) {
        case 'progress':
          p.onProgress({
            pathsDone: msg.pathsDone,
            pathsTotal: msg.pathsTotal,
            phase: msg.phase,
            solveIteration: msg.solveIteration,
          });
          break;
        case 'result':
          this.pending.delete(msg.id);
          p.resolve(msg.result);
          break;
        case 'cancelled':
          this.pending.delete(msg.id);
          p.reject(new Error('cancelled'));
          break;
        case 'error':
          this.pending.delete(msg.id);
          p.reject(new Error(msg.message));
          break;
      }
    };
  }

  price(req: PriceRequest, onProgress: (p: ProgressUpdate) => void): Promise<PriceResult> {
    return new Promise<PriceResult>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, onProgress });
      const msg: WorkerRequest = { type: 'price', payload: req };
      this.worker.postMessage(msg);
    });
  }

  cancel(id: string): void {
    const msg: WorkerRequest = { type: 'cancel', id };
    this.worker.postMessage(msg);
  }
}
