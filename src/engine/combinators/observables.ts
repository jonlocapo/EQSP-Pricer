import type { ObservablesEvaluator, PathObservables } from '../payoffs/types';

/**
 * Phase A for the combinator layer: identical shape and arithmetic to
 * makeCouponObservables (../payoffs/couponProducts.ts). It makes one pass
 * over the path, computing perfT, minPerf, maxPerf, and perf at each of
 * the contract's merged event grid indices. But it is parametrized
 * directly on the index list a compiled `Contract` needs, rather than
 * deriving it from grid.couponObs/callObs. It depends only on the
 * schedule shape, never on any Expr/Cmp numeric parameter. So it is
 * exactly the kind of `ObservablesEvaluator` pathCache.ts already knows
 * how to cache and replay.
 */
export function makeContractObservables(eventGridIndices: number[]): ObservablesEvaluator {
  const nEvents = eventGridIndices.length;

  return (spots: Float64Array): PathObservables => {
    const S0 = spots[0];
    const nSteps = spots.length - 1;
    const eventPerf = new Float64Array(nEvents);
    let ei = 0;
    let minPerf = Infinity;
    let maxPerf = -Infinity;

    for (let i = 1; i <= nSteps; i++) {
      const p = spots[i] / S0;
      if (p < minPerf) minPerf = p;
      if (p > maxPerf) maxPerf = p;
      if (ei < nEvents && eventGridIndices[ei] === i) {
        eventPerf[ei] = p;
        ei++;
      }
    }

    return { perfT: spots[nSteps] / S0, minPerf, maxPerf, eventPerf };
  };
}
