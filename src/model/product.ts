/**
 * Product specifications. Percent-valued fields carry a `Pct` suffix. They
 * are expressed as % of initial fixing, where 100 = at-the-money / par.
 * Everything in these specs affects pricing. There are deliberately no
 * cosmetic fields.
 *
 * `underlyings` carries one entry for a single-name product and two or more
 * for a worst-of basket. The coupon and participation families accept both.
 * `AccumulatorSpec` narrows it to exactly one, permanently, for the reason
 * given at that interface.
 *
 * A basket's per-leg volatilities, dividends and correlations live in
 * `MarketData.basket`, not here, because they are market data rather than
 * contract terms. The two lists are in the SAME ORDER.
 */

import type { LabSpec } from './lab';

export type BarrierMonitoring = 'none' | 'european' | 'american';
export type Frequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export const PERIODS_PER_YEAR: Record<Frequency, number> = {
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
};

/** Length of one period in whole months. The same four frequencies as
 * PERIODS_PER_YEAR, expressed the way a schedule is actually written. */
export const MONTHS_PER_PERIOD: Record<Frequency, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

/** Tolerance for calling a tenor a whole number of months. `1.5 * 12` is
 * exactly 18, but a tenor typed in years can land a float hair off. */
const MONTH_TOL = 1e-6;

/**
 * The tenor in whole months, or null when it is not a whole number of months.
 *
 * A note matures on a date, not part way through a month, so a tenor that is
 * not a whole number of months does not describe a real trade.
 */
export function tenorMonths(tenorYears: number): number | null {
  const months = tenorYears * 12;
  const rounded = Math.round(months);
  if (!Number.isFinite(months) || Math.abs(months - rounded) > MONTH_TOL) return null;
  return rounded;
}

/**
 * Whether a coupon or autocall frequency can be scheduled over this tenor.
 *
 * THE RULE: the tenor must be an exact multiple of the period. An 18-month
 * note can pay semiannually, quarterly or monthly. It cannot pay annually,
 * because the second annual date would fall six months after the note has
 * already matured.
 *
 * WHY IT IS ENFORCED RATHER THAN ACCOMMODATED. `periodicObs` and
 * `periodicTimes` count observations with `Math.round(tenorYears *
 * periodsPerYear)`, which for 18 months annual gives 2, placing a date at
 * year 2 on a note that ends at year 1.5. That date is then dropped on its
 * way to the grid, which left a HOLE in `couponObs` (`[1, null, 3]`) and a
 * duplicated final grid time with a zero-length step. Measured on an 8% p.a.
 * conditional coupon, the 18-month note paid one coupon worth 7.567 where the
 * 12-month note paid 7.577: the half-year stub silently vanished and the note
 * priced BELOW both its 1-year and 2-year neighbours.
 *
 * There is no stub convention to choose between here, because a real note's
 * tenor is always a multiple of its frequency. So the combination is refused
 * at the input, and again in validation.
 */
export function isFrequencyAllowed(tenorYears: number, frequency: Frequency): boolean {
  const months = tenorMonths(tenorYears);
  if (months === null || months <= 0) return false;
  return months % MONTHS_PER_PERIOD[frequency] === 0;
}

/** Every frequency this tenor can carry, longest period first. Empty only
 * when the tenor is not a whole number of months. */
export function allowedFrequencies(tenorYears: number): Frequency[] {
  return (['annual', 'semiannual', 'quarterly', 'monthly'] as Frequency[]).filter((f) =>
    isFrequencyAllowed(tenorYears, f),
  );
}

/**
 * `frequency` if this tenor allows it, otherwise the closest one it does.
 *
 * Used when the TENOR changes and strands a frequency that was legal a
 * moment ago. Editing 2 years to 18 months must not leave an annual coupon
 * selected. Prefers the longest allowed period no longer than the current
 * one, so an annual coupon on a new 18-month tenor becomes semiannual rather
 * than monthly. Falls back to the shortest allowed period, then returns the
 * frequency unchanged when nothing is allowed at all; validation reports that
 * case rather than this function guessing.
 */
export function coerceFrequency(tenorYears: number, frequency: Frequency): Frequency {
  if (isFrequencyAllowed(tenorYears, frequency)) return frequency;
  const allowed = allowedFrequencies(tenorYears);
  if (allowed.length === 0) return frequency;
  const want = MONTHS_PER_PERIOD[frequency];
  const shorter = allowed.filter((f) => MONTHS_PER_PERIOD[f] <= want);
  return shorter.length > 0 ? shorter[0] : allowed[allowed.length - 1];
}

export interface Underlying {
  name: string;
}

export interface CommonTerms {
  underlyings: Underlying[];
  notional: number;
  tenorYears: number;
  /** Target PV as % of notional for solve-for (reoffer). */
  reofferPct: number;
  issuePricePct: number;
}

// ---------------------------------------------------------------------------
// Page 1: RC/AC coupon products.
// RC = reverse convertible (callType 'none'); AC = RC + call feature.
// Phoenix = couponType 'memory'; not a separate product.
// ---------------------------------------------------------------------------

export type CallType = 'none' | 'constant' | 'stepdown' | 'custom' | 'issuerCallable';
export type CouponType = 'fixed' | 'conditional' | 'memory';
export type AcCouponType = 'none' | 'flat' | 'snowball';

export interface CouponProductSpec extends CommonTerms {
  kind: 'coupon';

  // Downside (short put, knocked in per monitoring)
  barrierType: BarrierMonitoring; // 'none' => put always live (plain RC)
  kiBarrierPct: number;
  putStrikePct: number;
  downsideLeveragePct: number; // 100 = standard geared put

  // Call feature
  callType: CallType;
  callFrequency: Frequency;
  /** First callable observation, 1-based period index. */
  callFromPeriod: number;
  /** Barrier for 'constant' and first barrier for 'stepdown'. */
  callBarrierPct: number;
  /** Subtracted per observation after the first callable one ('stepdown'). */
  stepDownPct: number;
  /**
   * For callType 'custom': one autocall barrier per call observation date.
   * Index 0 is the first observation, including non-callable ones before
   * callFromPeriod, which are ignored. Coupon terms stay global.
   */
  customCallBarriersPct: number[];

  // Periodic coupon
  couponType: CouponType;
  couponFrequency: Frequency;
  couponBarrierPct: number; // ignored for 'fixed'
  /** Coupon in % of notional per annum. */
  couponPaPct: number;

  /**
   * Additional coupon paid on redemption at call. 'none' means no AC
   * coupon. 'flat' means acCouponPct is paid once, in full, at whichever
   * period the note is called. 'snowball' means acCouponPct is % p.a.; it
   * pays acCouponPct × j / PERIODS_PER_YEAR[callFrequency] at call period
   * j, accruing with time.
   */
  acCouponType: AcCouponType;
  acCouponPct: number;
}

// ---------------------------------------------------------------------------
// Page 2: participation products.
// Every participation payoff equals one upside leg, plus one downside leg,
// plus an optional bonus, plus an optional protection floor. The four
// classic subtypes — Booster, Bonus, Capital Guaranteed, Twin Win — are UI
// presets that prefill this one generic spec. They are not separate model
// shapes.
// ---------------------------------------------------------------------------

export type UpsideVariant =
  | { variant: 'vanilla' }
  | { variant: 'callSpread'; upperStrikePct: number }
  | {
      variant: 'koRebate';
      koBarrierPct: number;
      koMonitoring: 'american' | 'european';
      /** Paid at maturity in place of the upside leg when KO'd, % of notional. */
      rebatePct: number;
    };

export interface PutSpread {
  /** Downside losses are floored below this level (% of initial). */
  lowerStrikePct: number;
}

export interface ParticipationSpec extends CommonTerms {
  kind: 'participation';
  upside: {
    strikePct: number;
    /** Upside participation/gearing, 100 = 1:1. */
    participationPct: number;
    variant: UpsideVariant;
  };
  downside: {
    strikePct: number;
    /** Raw-shortfall leverage convention; auto-default 10000/strikePct. */
    leveragePct: number;
    /** 'none' => loss leg always live (no knock-in condition). */
    barrierType: BarrierMonitoring;
    kiBarrierPct: number;
    putSpread?: PutSpread;
    /**
     * Positive participation in the downside while NOT knocked in,
     * twin-win. Only meaningful when barrierType !== 'none'. 0 means off.
     */
    twinWinPct: number;
  };
  /** Bonus amount in % ABOVE par (user quotes 15, not 115). 0 = none. */
  bonusPct: number;
  /** Capital protection floor as % of notional. 0 = none. */
  protectionPct: number;
}

// ---------------------------------------------------------------------------
// Page 3: accumulator.
// ---------------------------------------------------------------------------

export type KoSettlement = 'ko0' | 'ko1' | 'periodEnd';

/**
 * 'accumulate': the investor buys shares below spot (Accumulator/AQ). It
 * gears on down days, and the KO triggers above spot. 'decumulate': the
 * investor sells shares above spot (Decumulator/DQ). It gears on up days,
 * and the KO triggers below spot. These are mirror-image economics. See
 * accumulator.ts payoff for the shared formula.
 */
type AccumulatorDirection = 'accumulate' | 'decumulate';

/**
 * An accumulator keeps exactly one underlying, permanently. Two reasons:
 *
 * 1. An accumulator reads the strike on EVERY step of the path, so it
 *    cannot be reduced to summary observables the way a coupon or
 *    participation product can. It is the only product that must retain
 *    the whole path, so a worst-of collapse (see BasketParams in
 *    model/market.ts) would throw away the per-step detail the payoff
 *    actually reads.
 * 2. A worst-of accumulator is not a structure that trades. Nobody
 *    quotes a worst-of AQ/DQ, so this is a real product boundary, not a
 *    temporary v1 gap.
 */
export interface AccumulatorSpec {
  kind: 'accumulator';
  direction: AccumulatorDirection;
  underlyings: [Underlying];
  strikePct: number;
  /** Upfront value target, % of estimated notional (0 = zero-cost). */
  upfrontPct: number;
  tenorYears: number;
  settlementFrequency: 'weekly' | 'biweekly' | 'monthly';
  dailyShares: number;
  koTriggerPct: number;
  koSettlement: KoSettlement;
  /** Shares multiplier on days the underlying closes below strike. */
  gearing: 1 | 2;
  /** First N settlement periods accumulate regardless of KO. */
  guaranteePeriods: number;
}

// ---------------------------------------------------------------------------
// Contract Lab: a drag-and-drop block spec. See model/lab.ts for the block
// shapes. Imported here only as a type, so product.ts stays the single
// place ProductSpec is assembled, without owning the Lab's block-shape
// detail itself.
// ---------------------------------------------------------------------------

export type ProductSpec = CouponProductSpec | ParticipationSpec | AccumulatorSpec | LabSpec;
