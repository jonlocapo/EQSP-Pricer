import type { ProductSpec } from '../../model/product';
import type { EvaluatorContext, ObservablesRequirements, PayoffEvaluator, SplitEvaluator } from './types';
import type { PricingGrid } from './types';
import {
  couponObservablesRequirements,
  makeCouponEvaluator,
  mergeEvents,
  makeCouponObservables,
  makeCouponOutcome,
} from './couponProducts';
import {
  makeParticipationEvaluator,
  makeParticipationObservables,
  makeParticipationOutcome,
  participationObservablesRequirements,
} from './participation';
import { makeAccumulatorEvaluator } from './accumulator';
import { buildLabContract, labEventGridIndices, labObservablesRequirements } from '../combinators/lab';
import { compileContract } from '../combinators/compile';

/** No monolithic PayoffEvaluator exists for the Lab family — it always goes
 * through the combinator compiler (see makeSplitEvaluator below), the same
 * way every other product's split path does not fall back to a second,
 * independent implementation. `makeEvaluator` composes outcome(observables(spots))
 * from the compiled SplitEvaluator, so a caller that only knows the
 * monolithic PayoffEvaluator interface still gets a correct, if slightly
 * less cache-friendly, evaluator. */
export function makeEvaluator(spec: ProductSpec, ctx: EvaluatorContext): PayoffEvaluator {
  switch (spec.kind) {
    case 'coupon':
      return makeCouponEvaluator(spec, ctx);
    case 'participation':
      return makeParticipationEvaluator(spec, ctx);
    case 'accumulator':
      return makeAccumulatorEvaluator(spec, ctx);
    case 'lab': {
      const compiled = compileContract(buildLabContract(spec, ctx.grid), ctx);
      return (spots) => compiled.outcome(compiled.observables(spots));
    }
  }
}

/**
 * Observables-split evaluator for the families where it is a true no-op
 * decomposition: coupon non-issuerCallable, participation. See
 * PathObservables' doc comment. Returns null for families that do not
 * decompose. The accumulator's daily walk depends on the strike, a solve
 * target. issuerCallable coupons go through the LSMC cashflow-extractor
 * path instead, never through this evaluator at all.
 */
export function makeSplitEvaluator(spec: ProductSpec, ctx: EvaluatorContext): SplitEvaluator | null {
  switch (spec.kind) {
    case 'coupon':
      if (spec.callType === 'issuerCallable') return null;
      return {
        observables: makeCouponObservables(ctx, couponObservablesRequirements(spec)),
        outcome: makeCouponOutcome(spec, ctx),
      };
    case 'participation':
      return {
        observables: makeParticipationObservables(participationObservablesRequirements(spec)),
        outcome: makeParticipationOutcome(spec, ctx),
      };
    case 'accumulator':
      return null;
    case 'lab': {
      const compiled = compileContract(buildLabContract(spec, ctx.grid), ctx);
      return compiled;
    }
  }
}

/**
 * The observables requirements descriptor for a spec (see
 * `ObservablesRequirements`'s doc comment). Exposed so the pathCache's
 * observables sub-cache key can include it (see pricing.ts /
 * pathCache.ts's `computeObservablesKey`), without pathCache.ts needing to
 * know each family's monitoring-mode fields. Accumulator has no split
 * evaluator, so its requirements are unused. Return the harmless default.
 */
export function observablesRequirementsOf(spec: ProductSpec): ObservablesRequirements {
  switch (spec.kind) {
    case 'coupon':
      return couponObservablesRequirements(spec);
    case 'participation':
      return participationObservablesRequirements(spec);
    case 'accumulator':
      return { needsMin: false, needsMax: false };
    case 'lab':
      return labObservablesRequirements(spec);
  }
}

/**
 * The grid indices Phase A will write into `PathObservables.eventPerf`, for
 * this spec.
 *
 * WHY THE OBSERVABLES CACHE NEEDS THIS. `eventPerf` means something different
 * in each family. The coupon family fills it at every merged coupon or call
 * observation. The participation family leaves it empty, because no
 * participation payoff reads an intermediate level. A Lab contract fills it at
 * the CONTRACT's own event dates, which drop the autocall observations before
 * `fromPeriod` and so do not match the grid's `callObs`.
 *
 * The observables cache is one module-level slot per worker that survives
 * across requests and across product pages. Keying only on the grid's
 * observation sets let two different producers share one entry:
 *
 *  - A 1-year participation and a 1-year annual-coupon note both reduce to a
 *    single observation at maturity, so their keys matched. The coupon note
 *    then replayed the participation's slices, read past the end of an empty
 *    `eventPerf`, and every coupon and autocall test came back false. The note
 *    paid no coupons and never called, with nothing logged.
 *  - Editing a Lab autocall's `fromPeriod` changed the contract's event list
 *    but not the grid's `callObs`, so the key did not move. The cached slice
 *    still held the old event count, and the call tests read the wrong
 *    quarters' performances.
 *
 * Returning the real index list closes both. Two producers that write
 * different events now get different keys, and a `fromPeriod` edit moves the
 * key because it moves the list.
 */
export function observablesEventIndicesOf(spec: ProductSpec, grid: PricingGrid): number[] {
  switch (spec.kind) {
    case 'coupon':
      return mergeEvents(grid).map((e) => e.gridIndex);
    case 'lab':
      return labEventGridIndices(spec, grid);
    case 'participation':
    case 'accumulator':
      // Neither family reads an intermediate level, so Phase A writes no
      // events. An empty list is the honest descriptor, and it is what keeps
      // a participation key distinct from a coupon key.
      return [];
  }
}
