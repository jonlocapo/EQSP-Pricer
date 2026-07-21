import type { PriceRequest, PriceResult } from '../model/request';
import type { ProfileRequest, ProfileResult, WorkerRequest, WorkerResponse } from './protocol';
import type { PricerClient, ProfileProgressUpdate, ProgressUpdate } from './client';

interface Pending {
  resolve: (r: PriceResult) => void;
  reject: (e: Error) => void;
  onProgress: (p: ProgressUpdate) => void;
}

interface ProfilePending {
  resolve: (r: ProfileResult) => void;
  reject: (e: Error) => void;
  onProgress: (p: ProfileProgressUpdate) => void;
}

/** PricerClient backed by the Monte Carlo Web Worker. */
export class WorkerPricerClient implements PricerClient {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private profilePending = new Map<string, ProfilePending>();

  constructor() {
    this.worker = new Worker(new URL('./pricer.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      const pp = this.profilePending.get(msg.id);
      switch (msg.type) {
        case 'progress':
          p?.onProgress({
            pathsDone: msg.pathsDone,
            pathsTotal: msg.pathsTotal,
            phase: msg.phase,
            solveIteration: msg.solveIteration,
          });
          break;
        case 'result':
          if (p) {
            this.pending.delete(msg.id);
            p.resolve(msg.result);
          }
          break;
        case 'profileProgress':
          pp?.onProgress({ nodesDone: msg.nodesDone, nodesTotal: msg.nodesTotal });
          break;
        case 'profileResult':
          if (pp) {
            this.profilePending.delete(msg.id);
            pp.resolve(msg.result);
          }
          break;
        case 'cancelled':
          if (p) {
            this.pending.delete(msg.id);
            p.reject(new Error('cancelled'));
          }
          if (pp) {
            this.profilePending.delete(msg.id);
            pp.reject(new Error('cancelled'));
          }
          break;
        case 'error':
          if (p) {
            this.pending.delete(msg.id);
            p.reject(new Error(msg.message));
          }
          if (pp) {
            this.profilePending.delete(msg.id);
            pp.reject(new Error(msg.message));
          }
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

  profile(req: ProfileRequest, onProgress: (p: ProfileProgressUpdate) => void): Promise<ProfileResult> {
    return new Promise<ProfileResult>((resolve, reject) => {
      this.profilePending.set(req.id, { resolve, reject, onProgress });
      const msg: WorkerRequest = { type: 'profile', payload: req };
      this.worker.postMessage(msg);
    });
  }

  cancel(id: string): void {
    const msg: WorkerRequest = { type: 'cancel', id };
    this.worker.postMessage(msg);
  }
}
