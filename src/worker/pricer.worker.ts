/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { PoolMessage } from './poolProtocol';
import { CancelledError, evaluatePriceSlice, executePriceRequest, sliceSizeOf } from './pricing';
import type { SliceRunner } from './pricing';
import type { McRunResult } from '../engine/mc';

/**
 * Every pool worker runs this SAME script (see realClient.ts's WorkerPool).
 * So it plays two roles at once:
 *
 *  - Coordinator (worker index 0, the only one the main thread talks to via
 *    `self.onmessage`/`price`/`cancel`): runs the full `executePriceRequest`,
 *    including the LSMC/issuerCallable branch. That branch stays a single
 *    synchronous pass right here, off the main thread, exactly as before.
 *    For the ordinary, non-LSMC, slice loop, the coordinator farms slices
 *    out across the sibling ports below via `PoolSliceRunner`, instead of
 *    evaluating them in-process.
 *  - Sibling (any worker, including the coordinator for its own local
 *    share): serves `evalSlice` RPCs arriving on its pool port, by calling
 *    `evaluatePriceSlice` (pricing.ts). This is a pure, synchronous function
 *    of plain, cloneable, arguments. So results are bit-identical to the
 *    sequential single-worker path, regardless of which worker ran them.
 *
 * A single-worker pool — poolSize 1, or a failed Worker construction — has
 * zero sibling ports. `PoolSliceRunner` then only ever finds workerIndex 0,
 * this worker, and never touches the pool wiring at all. This is the same
 * code path, with no special-casing needed.
 */

const cancelledIds = new Set<string>();

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

/** Ports to sibling pool workers, indexed by their pool slot (1..poolSize-1;
 * slot 0 is always this worker itself, served locally with no port). Only
 * populated when this worker is the coordinator (see `attachPoolPort`
 * below). Empty otherwise, and empty entirely for a single-worker pool. */
const poolPorts = new Map<number, MessagePort>();
let poolSize = 1;

/** Pending sibling RPCs this worker, as coordinator, is waiting on, keyed
 * by `${reqId}:${sliceIndex}`. The key is composite because multiple price
 * requests can theoretically be in flight at once (see `self.onmessage`
 * below, which does not serialize distinct request ids), and slice indices
 * restart at 0 for each request. */
const pendingSliceResults = new Map<string, (r: McRunResult) => void>();

/** Farms priceOnce's slices across `poolPorts`. workerIndex 0 is this
 * worker, served locally with no round trip. See PricingHooks.sliceRunner's
 * doc in pricing.ts for the ordering guarantee that keeps this
 * bit-identical to the sequential path. */
class PoolSliceRunner implements SliceRunner {
  constructor(private readonly reqId: string) {}

  async runSlices(
    spec: Parameters<SliceRunner['runSlices']>[0],
    market: Parameters<SliceRunner['runSlices']>[1],
    numPaths: number,
    seed: number,
    antithetic: boolean,
    sliceIndices: number[],
    keepSamples: boolean,
    onSliceDone: (slicePaths: number) => void,
  ): Promise<McRunResult[]> {
    const jobs = sliceIndices.map((sliceIndex) => {
      const workerIndex = poolSize > 1 ? sliceIndex % poolSize : 0;
      const slicePaths = sliceSizeOf(numPaths, sliceIndex);
      if (workerIndex === 0) {
        // Local share: run right here, synchronously, wrapped in a resolved
        // Promise so it never blocks starting the sibling RPCs below. All
        // jobs are kicked off in the same synchronous pass — see Promise.all
        // over `jobs`.
        return Promise.resolve().then(() => {
          const result = evaluatePriceSlice(spec, market, numPaths, seed, antithetic, sliceIndex, keepSamples);
          onSliceDone(slicePaths);
          return result;
        });
      }
      const port = poolPorts.get(workerIndex);
      if (!port) {
        // Defensive fallback, should not happen once the pool is wired.
        // Evaluate locally, rather than hang forever waiting on a port that
        // does not exist.
        return Promise.resolve().then(() => {
          const result = evaluatePriceSlice(spec, market, numPaths, seed, antithetic, sliceIndex, keepSamples);
          onSliceDone(slicePaths);
          return result;
        });
      }
      return new Promise<McRunResult>((resolve) => {
        const key = `${this.reqId}:${sliceIndex}`;
        pendingSliceResults.set(key, (r) => {
          onSliceDone(slicePaths);
          resolve(r);
        });
        const msg: PoolMessage = {
          type: 'evalSlice',
          keepSamples,
          reqId: this.reqId,
          jobId: sliceIndex,
          spec,
          market,
          numPaths,
          seed,
          antithetic,
          sliceIndex,
        };
        port.postMessage(msg);
      });
    });
    return Promise.all(jobs);
  }
}

/** Handles messages on a sibling role port: `evalSlice` requests from the
 * coordinator, responding with `evalSliceResult`, and `cancelReq`.
 * `cancelReq` mirrors into the same `cancelledIds` set the top-level
 * `cancel` protocol uses. So a request cancelled at the coordinator also
 * stops this worker from starting any NOT-YET-STARTED slice for it. An
 * already-dispatched `evalSlice` still runs to completion — the same
 * per-slice cancellation granularity the single-worker path always had. */
function handleSiblingPortMessage(port: MessagePort, data: PoolMessage): void {
  if (data.type === 'evalSlice') {
    if (cancelledIds.has(data.reqId)) {
      // Cheap stub. The coordinator discards the whole run's result once it
      // sees the request is cancelled, so the numeric content is never used.
      const stub: McRunResult = {
        pvPct: 0,
        stderrPct: 0,
        cancelled: true,
        diagnostics: { callProb: [], kiProb: 0, upsideKoProb: 0, koProb: 0, expectedLifeYears: 0 },
        samples: [],
      };
      const resp: PoolMessage = { type: 'evalSliceResult', reqId: data.reqId, jobId: data.jobId, result: stub };
      port.postMessage(resp);
      return;
    }
    const result = evaluatePriceSlice(data.spec, data.market, data.numPaths, data.seed, data.antithetic, data.sliceIndex, data.keepSamples ?? true);
    const resp: PoolMessage = { type: 'evalSliceResult', reqId: data.reqId, jobId: data.jobId, result };
    port.postMessage(resp);
  } else if (data.type === 'cancelReq') {
    cancelledIds.add(data.reqId);
  }
}

/** Handles messages on a coordinator role port. This worker sent
 * `evalSlice` down it, and is waiting for `evalSliceResult`. */
function handleCoordinatorPortMessage(data: PoolMessage): void {
  if (data.type === 'evalSliceResult') {
    const key = `${data.reqId}:${data.jobId}`;
    const resolve = pendingSliceResults.get(key);
    if (resolve) {
      pendingSliceResults.delete(key);
      resolve(data.result);
    }
  }
}

self.onmessage = (
  ev: MessageEvent<WorkerRequest | { type: 'attachPoolPort'; role: 'coordinator' | 'sibling'; workerIndex?: number; poolSize?: number; port: MessagePort }>,
) => {
  const msg = ev.data;

  if (msg.type === 'attachPoolPort') {
    if (msg.role === 'coordinator') {
      poolSize = msg.poolSize ?? poolSize;
      poolPorts.set(msg.workerIndex!, msg.port);
      msg.port.onmessage = (portEv: MessageEvent<PoolMessage>) => handleCoordinatorPortMessage(portEv.data);
    } else {
      msg.port.onmessage = (portEv: MessageEvent<PoolMessage>) => handleSiblingPortMessage(msg.port, portEv.data);
    }
    return;
  }

  if (msg.type === 'cancel') {
    cancelledIds.add(msg.id);
    // Reach every worker with potentially in-flight slices for this request,
    // not just this one. Already-dispatched `evalSlice` RPCs still run to
    // completion (see handleSiblingPortMessage's doc). This only stops
    // NOT-YET-STARTED work. Combined with priceOnce's hooks.isCancelled()
    // check, it stops further dispatch.
    for (const port of poolPorts.values()) {
      const cancelMsg: PoolMessage = { type: 'cancelReq', reqId: msg.id };
      port.postMessage(cancelMsg);
    }
    return;
  }

  const req = msg.payload;
  void (async () => {
    try {
      const result = await executePriceRequest(req, {
        onProgress: (pathsDone, pathsTotal, phase, solveIteration) =>
          post({ type: 'progress', id: req.id, pathsDone, pathsTotal, phase, solveIteration }),
        isCancelled: () => cancelledIds.has(req.id),
        yieldNow: () => new Promise((r) => setTimeout(r, 0)),
        sliceRunner: new PoolSliceRunner(req.id),
      });
      if (result === null || cancelledIds.has(req.id)) {
        post({ type: 'cancelled', id: req.id });
      } else {
        post({ type: 'result', id: req.id, result });
      }
    } catch (e) {
      if (e instanceof CancelledError || cancelledIds.has(req.id)) {
        post({ type: 'cancelled', id: req.id });
      } else {
        post({ type: 'error', id: req.id, message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      cancelledIds.delete(req.id);
    }
  })();
};
