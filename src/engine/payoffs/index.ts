import type { ProductSpec } from '../../model/product';
import type { EvaluatorContext, PayoffEvaluator, SplitEvaluator } from './types';
import { makeCouponEvaluator, makeCouponObservables, makeCouponOutcome } from './couponProducts';
import {
  makeParticipationEvaluator,
  makeParticipationObservables,
  makeParticipationOutcome,
} from './participation';
import { makeAccumulatorEvaluator } from './accumulator';

export function makeEvaluator(spec: ProductSpec, ctx: EvaluatorContext): PayoffEvaluator {
  switch (spec.kind) {
    case 'coupon':
      return makeCouponEvaluator(spec, ctx);
    case 'participation':
      return makeParticipationEvaluator(spec, ctx);
    case 'accumulator':
      return makeAccumulatorEvaluator(spec, ctx);
  }
}

/**
 * Observables-split evaluator for the families where it's a true no-op
 * decomposition (coupon non-issuerCallable, participation) — see
 * PathObservables' doc comment. Returns null for families that don't
 * decompose (accumulator's daily walk depends on the strike, a solve target;
 * issuerCallable coupons go through the LSMC cashflow-extractor path
 * instead, never through this evaluator at all).
 */
export function makeSplitEvaluator(spec: ProductSpec, ctx: EvaluatorContext): SplitEvaluator | null {
  switch (spec.kind) {
    case 'coupon':
      if (spec.callType === 'issuerCallable') return null;
      return { observables: makeCouponObservables(ctx), outcome: makeCouponOutcome(spec, ctx) };
    case 'participation':
      return { observables: makeParticipationObservables(), outcome: makeParticipationOutcome(spec, ctx) };
    case 'accumulator':
      return null;
  }
}
