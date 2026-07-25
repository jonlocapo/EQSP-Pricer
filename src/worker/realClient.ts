import type { PriceRequest, PriceResult } from '../model/request';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { PricerClient, ProgressUpdate } from './client';

interface Pending {
  resolve: (r: PriceResult) => void;
  reject: (e: Error) => void;
  onProgress: (p: ProgressUpdate) => void;
}

/** Cap on pool size. `priceOnce`'s slices are only ever as numerous as
 * `numPaths / 20_000`, 5 for a 100k-path run. Each pool worker holds its
 * own roughly 100-300MB of path and normals caches (see pathCache.ts) once
 * warm. More workers than that buys nothing and multiplies memory. So this
 * is a sensible ceiling, regardless of how many cores the machine
 * reports. */
const MAX_POOL_SIZE = 8;
const MIN_POOL_SIZE = 4;

function desiredPoolSize(): number {
  const cores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 1;
  if (cores <= 1) return 1;
  return Math.max(MIN_POOL_SIZE, Math.min(MAX_POOL_SIZE, cores));
}

function spawnWorker(): Worker {
  return new Worker(new URL('./pricer.worker.ts', import.meta.url), { type: 'module' });
}

/**
 * PricerClient backed by a pool of identical Monte Carlo Web Workers.
 *
 * Worker 0 is the "coordinator". The main thread only ever talks to it,
 * using the same wire protocol as the original single-worker client —
 * WorkerRequest/WorkerResponse, unchanged. It alone runs
 * `executePriceRequest`, including the LSMC/issuerCallable branch, which
 * stays one synchronous pass on that single worker. For the ordinary Monte
 * Carlo slice loop, the coordinator farms slices out across the rest of
 * the pool via sibling MessageChannel ports wired up below
 * (`pricer.worker.ts`'s `PoolSliceRunner`). The assignment is
 * `s % poolSize`, so the same slice always lands on the same worker across
 * a solve's many `priceOnce` calls. This keeps that worker's path,
 * observables, and normals caches warm.
 *
 * Falls back to a single worker — poolSize 1, no pool wiring at all — when
 * `navigator.hardwareConcurrency` is 1, or Worker construction throws, for
 * example in an environment without module worker support. In that case,
 * `pricer.worker.ts`'s `PoolSliceRunner` degrades to "workerIndex is
 * always 0". So no separate code path is needed for it.
 */
export class WorkerPricerClient implements PricerClient {
  private coordinator: Worker;
  /** Kept alive by holding a reference; nothing else pins them. Never read
   * again after wiring, but must not be garbage-collected for the pool to
   * keep working. */
  private readonly siblingWorkers: Worker[];
  private pending = new Map<string, Pending>();

  constructor() {
    const size = desiredPoolSize();
    let coordinator: Worker;
    const siblings: Worker[] = [];
    try {
      coordinator = spawnWorker();
      for (let i = 1; i < size; i++) {
        siblings.push(spawnWorker());
      }
    } catch {
      // Worker construction failed, an unsupported environment. Fall back to
      // a single coordinator-only worker. If even that throws, propagate the
      // error; there is no usable fallback below "one worker".
      siblings.length = 0;
      coordinator = spawnWorker();
    }
    this.coordinator = coordinator;
    this.siblingWorkers = siblings;

    const poolSize = 1 + siblings.length;
    for (let i = 0; i < siblings.length; i++) {
      const workerIndex = i + 1;
      const channel = new MessageChannel();
      this.coordinator.postMessage(
        { type: 'attachPoolPort', role: 'coordinator', workerIndex, poolSize, port: channel.port1 },
        [channel.port1],
      );
      siblings[i].postMessage({ type: 'attachPoolPort', role: 'sibling', port: channel.port2 }, [channel.port2]);
    }

    this.coordinator.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handleMessage(ev.data);
  }

  private handleMessage(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
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
      case 'cancelled':
        if (p) {
          this.pending.delete(msg.id);
          p.reject(new Error('cancelled'));
        }
        break;
      case 'error':
        if (p) {
          this.pending.delete(msg.id);
          p.reject(new Error(msg.message));
        }
        break;
    }
  }

  price(req: PriceRequest, onProgress: (p: ProgressUpdate) => void): Promise<PriceResult> {
    return new Promise<PriceResult>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, onProgress });
      const msg: WorkerRequest = { type: 'price', payload: req };
      this.coordinator.postMessage(msg);
    });
  }

  /** Cancels at the coordinator. The coordinator forwards a `cancelReq`
   * down every sibling pool port, so a cancel reaches every worker with,
   * or about to have, in-flight slices for `id` — see pricer.worker.ts's
   * `cancel` handler. */
  cancel(id: string): void {
    const msg: WorkerRequest = { type: 'cancel', id };
    this.coordinator.postMessage(msg);
  }

  /** Tears down the whole pool, coordinator and siblings. Not currently
   * called anywhere in the app; the client lives for the page's lifetime.
   * Provided for symmetry and tests, and to keep `siblingWorkers`
   * demonstrably live for the pool's whole lifetime, rather than a
   * write-only field. */
  terminate(): void {
    this.coordinator.terminate();
    for (const w of this.siblingWorkers) w.terminate();
  }
}
