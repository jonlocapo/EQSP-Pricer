import type { AccumulatorSpec, CouponProductSpec, ParticipationSpec } from '../model/product';
import type { MarketData } from '../model/market';

export type FieldErrors = Record<string, string>;

export interface ValidationResult {
  errors: FieldErrors;
  rowErrors?: string[];
  valid: boolean;
}

function commonErrors(notional: number, tenorYears: number): FieldErrors {
  const errors: FieldErrors = {};
  if (!(notional > 0)) errors.notional = 'Notional must be positive.';
  if (!(tenorYears > 0) || tenorYears > 10) errors.tenorYears = 'Tenor must be > 0 and ≤ 10y.';
  return errors;
}

function marketErrors(market: MarketData): FieldErrors {
  const errors: FieldErrors = {};
  if (!(market.spot > 0)) errors.spot = 'Spot must be positive.';
  return errors;
}

function callObservationCount(spec: CouponProductSpec): number {
  const perYear = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 }[spec.callFrequency];
  return Math.max(1, Math.round(spec.tenorYears * perYear));
}

export function validateCoupon(spec: CouponProductSpec, market: MarketData): ValidationResult {
  const errors: FieldErrors = { ...commonErrors(spec.notional, spec.tenorYears), ...marketErrors(market) };
  const rowErrors: string[] = [];

  if (spec.reofferPct < 0) errors.reofferPct = 'Must be ≥ 0.';
  if (spec.issuePricePct < 0) errors.issuePricePct = 'Must be ≥ 0.';

  // At or below, not strictly below: a one-star / airbag note sets the put
  // strike EQUAL to the barrier on purpose, so that the loss is measured from
  // the barrier rather than from par. Requiring a strict inequality rejected a
  // legitimate and common structure.
  if (spec.barrierType !== 'none' && !(spec.kiBarrierPct <= spec.putStrikePct)) {
    errors.kiBarrierPct = 'KI barrier cannot be above the put strike.';
  }

  if (spec.callType === 'custom') {
    spec.customCallBarriersPct.forEach((v, i) => {
      rowErrors[i] = v > 0 ? '' : 'Must be > 0.';
    });
  }

  const nObs = callObservationCount(spec);
  if (spec.callType !== 'none') {
    if (!(spec.callFromPeriod >= 1) || spec.callFromPeriod > nObs) {
      errors.callFromPeriod = `Non-call periods must be between 0 and ${nObs - 1}.`;
    }
  }

  const valid = Object.keys(errors).length === 0 && rowErrors.every((e) => !e);
  return { errors, rowErrors, valid };
}

export function validateParticipation(spec: ParticipationSpec, market: MarketData): ValidationResult {
  const errors: FieldErrors = { ...commonErrors(spec.notional, spec.tenorYears), ...marketErrors(market) };

  if (spec.upside.variant.variant === 'callSpread') {
    if (!(spec.upside.variant.upperStrikePct > spec.upside.strikePct)) {
      errors.upperStrikePct = 'Must be above upside strike.';
    }
  }
  if (spec.upside.variant.variant === 'koRebate') {
    if (!(spec.upside.variant.koBarrierPct > 100)) {
      errors.koBarrierPct = 'Must be > 100.';
    }
  }

  // At or below, not strictly below — see the coupon note above: an airbag
  // deliberately puts the barrier and the downside strike at the same level.
  if (spec.downside.barrierType !== 'none' && !(spec.downside.kiBarrierPct <= spec.downside.strikePct)) {
    errors.kiBarrierPct = 'KI barrier cannot be above the downside strike.';
  }

  if (spec.downside.putSpread) {
    if (!(spec.downside.putSpread.lowerStrikePct < spec.downside.strikePct)) {
      errors.lowerStrikePct = 'Must be below downside strike.';
    }
  }

  const valid = Object.keys(errors).length === 0;
  return { errors, valid };
}

export function validateAccumulator(spec: AccumulatorSpec, market: MarketData): ValidationResult {
  const errors: FieldErrors = { ...commonErrors(1, spec.tenorYears), ...marketErrors(market) };
  delete errors.notional;
  if (!(spec.dailyShares > 0)) errors.dailyShares = 'Must be positive.';
  // The trigger may sit exactly ON the strike. That is a real structure, the
  // knock-out coinciding with the level being dealt at, so the comparison is
  // inclusive. The same reasoning applies to an airbag, whose knock-in barrier
  // legitimately equals its put strike (see validateCoupon).
  if (spec.direction === 'decumulate') {
    if (!(spec.koTriggerPct <= spec.strikePct)) errors.koTriggerPct = 'Trigger cannot be above strike.';
  } else {
    if (!(spec.koTriggerPct >= spec.strikePct)) errors.koTriggerPct = 'Trigger cannot be below strike.';
  }
  const valid = Object.keys(errors).length === 0;
  return { errors, valid };
}
