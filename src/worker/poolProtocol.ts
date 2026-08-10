/**
 * Wire protocol for the sibling-to-sibling MessageChannel ports that connect
 * the coordinator worker (worker[0], the one the main thread talks to — see
 * realClient.ts) to the rest of the pool. Kept separate from protocol.ts,
 * the main-thread-to-coordinator protocol, unchanged, because this one
 * only ever travels worker-to-worker.
 *
 * Each pool worker, including the coordinator for its own local share,
 * evaluates slices via `evaluatePriceSlice` (src/worker/pricing.ts). This
 * is a pure, synchronous, structured-cloneable-in/out function. So a slice
 * job is just its plain arguments, and a slice result is just a
 * McRunResult.
 */
import type { MarketData } from '../model/market';
import type { ProductSpec } from '../model/product';
import type { McRunResult } from '../engine/mc';

export type PoolMessage =
  | {
      type: 'evalSlice';
      /** Whether the coordinator will build the distribution diagnostics from
       * the pooled samples. Optional so an older message still behaves as it
       * did, by keeping them. */
      keepSamples?: boolean;
      reqId: string;
      jobId: number;
      spec: ProductSpec;
      market: MarketData;
      numPaths: number;
      seed: number;
      antithetic: boolean;
      sliceIndex: number;
    }
  | { type: 'evalSliceResult'; reqId: string; jobId: number; result: McRunResult }
  | { type: 'cancelReq'; reqId: string };
