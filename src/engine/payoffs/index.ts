import type { ProductSpec } from '../../model/product';
import type { EvaluatorContext, ObservablesRequirements, PayoffEvaluator, SplitEvaluator } from './types';
import {
  couponObservablesRequirements,
  makeCouponEvaluator,
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
import { buildLabContract, labObservablesRequirements } from '../combinators/lab';
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
