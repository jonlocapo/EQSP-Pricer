/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse } from './protocol';
import { CancelledError, executePriceRequest } from './pricing';

const cancelledIds = new Set<string>();

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    cancelledIds.add(msg.id);
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
