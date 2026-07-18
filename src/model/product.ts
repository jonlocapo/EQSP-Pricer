/**
 * Product specifications. Percent-valued fields carry a `Pct` suffix and are
 * expressed as % of initial fixing (100 = at-the-money / par). Everything in
 * these specs affects pricing; there are deliberately no cosmetic fields.
 *
 * Single underlying in v1. `underlyings` is an array so worst-of baskets can
 * be added later without reshaping the contract.
 */

export type BarrierMonitoring = 'none' | 'european' | 'american';
export type Frequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export const PERIODS_PER_YEAR: Record<Frequency, number> = {
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
};

export interface Underlying {
  name: string;
}

export interface CommonTerms {
  underlyings: Underlying[];
  currency: string;
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
   * For callType 'custom': one autocall barrier per call observation date
   * (index 0 = first observation, including non-callable ones before
   * callFromPeriod, which are ignored). Coupon terms stay global.
   */
  customCallBarriersPct: number[];

  // Periodic coupon
  couponType: CouponType;
  couponFrequency: Frequency;
  couponBarrierPct: number; // ignored for 'fixed'
  /** Coupon in % of notional per annum. */
  couponPaPct: number;

  /**
   * Additional coupon paid on redemption at call. 'none' => no AC coupon.
   * 'flat' => acCouponPct paid once, in full, at whichever period the note
   * is called. 'snowball' => acCouponPct is % p.a.; pays acCouponPct × j /
   * PERIODS_PER_YEAR[callFrequency] at call period j (accrues with time).
   */
  acCouponType: AcCouponType;
  acCouponPct: number;
}

// ---------------------------------------------------------------------------
// Page 2: participation products.
// Every participation payoff = one upside leg + one downside leg + optional
// bonus + optional protection floor. The four classic subtypes (Booster,
// Bonus, Capital Guaranteed, Twin Win) are UI presets that prefill this one
// generic spec — they are not separate model shapes.
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
     * Positive participation in the downside while NOT knocked in
     * (twin-win). Only meaningful when barrierType !== 'none'. 0 = off.
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
 * 'accumulate': investor buys shares below spot (Accumulator/AQ) — geared on
 * down days, KO triggers above spot. 'decumulate': investor sells shares
 * above spot (Decumulator/DQ) — geared on up days, KO triggers below spot.
 * Mirror-image economics; see accumulator.ts payoff for the shared formula.
 */
export type AccumulatorDirection = 'accumulate' | 'decumulate';

export interface AccumulatorSpec {
  kind: 'accumulator';
  direction: AccumulatorDirection;
  underlyings: Underlying[];
  currency: string;
  strikePct: number;
  /** Upfront value target, % of estimated notional (0 = zero-cost). */
  upfrontPct: number;
  tenorYears: number;
  settlementFrequency: 'weekly' | 'monthly';
  dailyShares: number;
  koTriggerPct: number;
  koSettlement: KoSettlement;
  /** Shares multiplier on days the underlying closes below strike. */
  gearing: 1 | 2;
  /** First N settlement periods accumulate regardless of KO. */
  guaranteePeriods: number;
}

export type ProductSpec = CouponProductSpec | ParticipationSpec | AccumulatorSpec;
