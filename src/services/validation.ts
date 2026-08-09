import type { AccumulatorSpec, CouponProductSpec, ParticipationSpec, Underlying } from '../model/product';
import type { MarketData } from '../model/market';

type FieldErrors = Record<string, string>;

interface ValidationResult {
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
    // At or above, not strictly above. The airbag precedent: equal levels
    // are a degenerate but legitimate structure. A call-spread cap EQUAL to
    // the upside strike is a zero-width cap; the payoff is well-defined
    // (no extra upside beyond the strike), and a solve-for that lands on
    // the boundary must not be rejected after write-back.
    if (!(spec.upside.variant.upperStrikePct >= spec.upside.strikePct)) {
      errors.upperStrikePct = 'Must be at or above the upside strike.';
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
    // At or below, not strictly below — the airbag precedent again. A
    // put-spread floor EQUAL to the downside strike leaves no floor beyond
    // the strike itself; the payoff is well-defined, and a boundary solve
    // must not be rejected after write-back.
    if (!(spec.downside.putSpread.lowerStrikePct <= spec.downside.strikePct)) {
      errors.lowerStrikePct = 'Must be at or below the downside strike.';
    }
  }

  const valid = Object.keys(errors).length === 0;
  return { errors, valid };
}

/**
 * Rules for a worst-of basket (two or more legs). Returns no errors at all
 * for a single leg: today's behavior stays untouched.
 *
 * `rawCorrelation` is the matrix as the user typed it, before
 * `repairCorrelation` runs. The [-1, 1] bound is checked here, on the raw
 * entry, because repair always produces entries inside that range by
 * construction (a valid correlation matrix cannot hold one outside it), so
 * checking the repaired matrix could never catch a bad typed value.
 */
export function validateBasket(
  underlyings: Underlying[],
  rawCorrelation: number[][] | undefined,
  market: MarketData
): ValidationResult {
  const errors: FieldErrors = {};
  if (underlyings.length >= 2) {
    const seen = new Set<string>();
    underlyings.forEach((u, i) => {
      const name = u.name.trim();
      if (!name) {
        errors[`underlying${i}`] = 'Underlying name is required.';
        return;
      }
      const key = name.toLowerCase();
      // A "worst-of X and X" is just X: two legs on the same name add no
      // diversification and the engine gains nothing from pricing them as
      // a basket, so this is rejected rather than silently priced.
      if (seen.has(key)) {
        errors[`underlying${i}`] = 'Duplicate underlying: a worst-of basket needs distinct legs.';
      }
      seen.add(key);
    });

    if (rawCorrelation) {
      outer: for (const row of rawCorrelation) {
        for (const v of row) {
          if (!Number.isFinite(v) || v < -1 || v > 1) {
            errors.correlation = 'Correlation entries must be between -1 and 1.';
            break outer;
          }
        }
      }
    }

    // A basket cannot be quanto: the engine throws (see model/market.ts,
    // riskNeutralDrift). Quanto needs one equity-FX correlation per leg,
    // which this model does not carry, so the two features are mutually
    // exclusive rather than combinable.
    if (market.quanto) {
      errors.basket = 'Worst-of baskets must be single-currency. Resolve the quanto mismatch first.';
    }
  }
  return { errors, valid: Object.keys(errors).length === 0 };
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
