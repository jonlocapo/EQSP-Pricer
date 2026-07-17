import type { ProductSpec } from '../../model/product';
import type { EvaluatorContext, PayoffEvaluator } from './types';
import { makeCouponEvaluator } from './couponProducts';
import { makeParticipationEvaluator } from './participation';
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
