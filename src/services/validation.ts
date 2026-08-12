import type { AccumulatorSpec, CouponProductSpec, ParticipationSpec } from '../model/product';
import { isFrequencyAllowed, tenorMonths } from '../model/product';
import type { LegQuantoParams, MarketData } from '../model/market';
import { legQuantoOf } from '../model/market';

/** One basket leg's identity, as far as `validateBasket` needs it. `name` is
 * the same value `spec.underlyings` carries; `ticker` and `currency` are
 * extra, UI-only fields the pricing spec itself does not hold (see
 * `pageHelpers.ts`'s `BasketLegRef`, which supplies this shape from the
 * store). Both extra fields are optional so a plain `{ name }` literal, as
 * every existing call site and test passes, still satisfies this type. */
interface BasketLegRef {
  name: string;
  ticker?: string;
  currency?: string;
}

type FieldErrors = Record<string, string>;

interface ValidationResult {
  errors: FieldErrors;
  rowErrors?: string[];
  valid: boolean;
}

function commonErrors(notional: number, tenorYears: number): FieldErrors {
  const errors: FieldErrors = {};
  if (!(notional > 0)) errors.notional = 'Notional must be positive.';
  if (!(tenorYears > 0) || tenorYears > 10) {
    errors.tenorYears = 'Tenor must be > 0 and ≤ 10y.';
  } else if (tenorMonths(tenorYears) === null) {
    // A note matures on a date, so its tenor is a whole number of months.
    // Report that here rather than letting it surface as every frequency
    // being unavailable, which describes the symptom and not the cause.
    errors.tenorYears = 'Tenor must be a whole number of months.';
  }
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

  // The tenor must be an exact multiple of every schedule's period. The
  // pickers already grey out the periods that do not divide, but a UI control
  // is not a model invariant: a stored trade or a restored history entry can
  // carry any combination. An overshooting observation leaves a hole in
  // couponObs and silently drops a coupon, so refuse it here too. See
  // `isFrequencyAllowed`.
  if (!isFrequencyAllowed(spec.tenorYears, spec.couponFrequency)) {
    errors.couponFrequency = 'The tenor is not a whole number of these periods.';
  }
  if (spec.callType !== 'none' && !isFrequencyAllowed(spec.tenorYears, spec.callFrequency)) {
    errors.callFrequency = 'The tenor is not a whole number of these periods.';
  }

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
 * What is wrong with a foreign leg's quanto inputs, or an empty string when
 * the inputs can price. The caller prefixes the leg's identity.
 *
 * The FX volatility must be positive and the correlation must be a real
 * correlation. A zero FX volatility is not a neutral default: it says the two
 * currencies never move against each other, which turns the quanto note into
 * a plain note and hides the very risk the inputs exist to price.
 *
 * `legCurrency` is the currency the ticker actually trades in. A leg's own
 * quanto block names its currency, so a mismatch means the inputs are left
 * over from an earlier currency and describe the wrong FX rate. The primary
 * leg's fallback block (see `legQuantoOf`) carries the placeholder name
 * 'primary' and skips that comparison.
 */
function quantoInputProblem(quanto: LegQuantoParams | undefined, legCurrency: string): string {
  if (!quanto) {
    return 'Fetch or type this leg’s rate, FX vol and equity-FX correlation before pricing.';
  }
  if (quanto.currency !== 'primary' && quanto.currency !== legCurrency) {
    return `Its quanto inputs are for ${quanto.currency}. Refresh them for ${legCurrency}.`;
  }
  if (!Number.isFinite(quanto.rateUnderlying)) return 'Its own risk-free rate is missing.';
  if (!(quanto.fxVol > 0) || !Number.isFinite(quanto.fxVol)) return 'Its FX vol must be above zero.';
  if (!Number.isFinite(quanto.corrEqFx) || quanto.corrEqFx < -1 || quanto.corrEqFx > 1) {
    return 'Its equity-FX correlation must be between -1 and 1.';
  }
  return '';
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
 *
 * A basket MAY mix currencies. Each leg outside the note currency prices as a
 * quanto leg, so the rule this function enforces is not "one currency" but
 * "every foreign leg carries the three quanto inputs its drift needs". See
 * `quantoInputProblem`.
 */
export function validateBasket(
  underlyings: BasketLegRef[],
  rawCorrelation: number[][] | undefined,
  market: MarketData
): ValidationResult {
  const errors: FieldErrors = {};

  // A trade needs an underlying, whatever the leg count. Nothing downstream
  // can price "no name": the spot, the volatility and the dividend all belong
  // to a specific instrument. Checked here rather than only for a basket,
  // because the single-name case is the one a user actually reaches by
  // clearing the field.
  if (!underlyings[0] || !underlyings[0].name.trim()) {
    errors.underlying0 = 'Select an underlying.';
  }

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

      // A MULTI-CURRENCY worst-of is allowed: the engine gives each foreign
      // leg its own quanto drift (see engine/gbm.ts's
      // `buildBasketCoefficients`). What is NOT allowed is a foreign leg with
      // no quanto inputs. That leg would drift at the NOTE currency's rate
      // with no equity-FX correction, which is a silent misprice — the same
      // failure the old single-currency rule existed to stop.
      const label = u.ticker?.trim() || name;
      const quanto = legQuantoOf(market, i);
      if (u.currency && u.currency !== market.currency) {
        const problem = quantoInputProblem(quanto, u.currency);
        if (problem) {
          errors[`currency${i}`] = `Leg ${i + 1} (${label}) is ${u.currency} but the note is ${market.currency}. ${problem}`;
        }
      } else if (u.currency && u.currency === market.currency && quanto) {
        // A leg that moved back into the note currency must lose its quanto
        // inputs with the move. Stale inputs are not harmless here: the engine
        // applies the correction to any leg that carries one, so the leg would
        // price with an FX adjustment it no longer has.
        errors[`currency${i}`] =
          `Leg ${i + 1} (${label}) is now ${market.currency}, the note currency, but still carries quanto inputs. Clear them.`;
      }
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

  }
  return { errors, valid: Object.keys(errors).length === 0 };
}

export function validateAccumulator(spec: AccumulatorSpec, market: MarketData): ValidationResult {
  const errors: FieldErrors = { ...commonErrors(1, spec.tenorYears), ...marketErrors(market) };
  delete errors.notional;
  if (!(spec.dailyShares > 0)) errors.dailyShares = 'Must be positive.';
  // An accumulator is single-underlying, permanently (see AccumulatorSpec).
  // The only thing keeping a basket off it was a React effect in the market
  // panel that rebuilds `market.basket` from one leg when the accumulator tab
  // is active. A UI effect is not a model invariant: if a basket ever reaches
  // here, through a history restore or a render ordering change, the daily
  // accumulation walk runs on collapsed worst-of paths and reports a confident
  // number. Refuse it the way validateBasket refuses basket plus quanto.
  if (market.basket && market.basket.assets.length >= 2) {
    errors.underlyings = 'An accumulator takes one underlying. Remove the extra basket legs.';
  }
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
