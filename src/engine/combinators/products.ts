import type { BarrierMonitoring, CouponProductSpec, Frequency, ParticipationSpec } from '../../model/product';
import { PERIODS_PER_YEAR } from '../../model/product';
import {
  callBarrierDecimal,
  couponAmountPct,
  isCallable,
  mergeEvents,
  redemptionCostPctAt,
} from '../payoffs/couponProducts';
import type { PricingGrid } from '../payoffs/types';
import type { Contract, ScheduleEvent } from './contract';
import {
  add,
  alwaysTrue,
  cap,
  floor as eFloor,
  gte,
  ite,
  konst,
  lt,
  max,
  perfAt,
  perfT,
  scale,
  sub,
} from './expr';
import type { Cmp, Expr } from './expr';

/**
 * Worked examples: the same three product families the hand-written
 * evaluators cover (reverse convertible / participation booster), plus a
 * Catapult (autocall + geared participation + protection) with no
 * hand-written oracle, all expressed as `Contract` trees built from the
 * primitive algebra in expr.ts. See tests/combinators.test.ts for the
 * per-path equivalence proof against makeCouponEvaluator/
 * makeParticipationEvaluator.
 */

// ---------------------------------------------------------------------------
// Reverse convertible / autocallable coupon note (mirrors couponProducts.ts).
// ---------------------------------------------------------------------------

/** Builds the same contract shape makeCouponEvaluator/makeCouponOutcome
 * implement monolithically: autocall schedule with per-period barrier and
 * redemption cost, a periodic coupon leg (fixed/conditional/memory), and a
 * KI-conditional geared-put maturity leg. Barrier levels, coupon amounts,
 * and redemption costs are *numbers*, computed with the exact same pure
 * helpers couponProducts.ts uses (thin exports — no logic duplicated for
 * those), but the per-path decision logic (which barrier to compare
 * against, whether to autocall, how the payoff composes) is rebuilt
 * independently here from the Expr/Cmp primitives — that reconstruction is
 * what tests/combinators.test.ts proves equivalent. */
export function buildReverseConvertible(spec: CouponProductSpec, grid: PricingGrid): Contract {
  const mergedEvents = mergeEvents(grid);
  const couponAmt = couponAmountPct(spec);

  const events: ScheduleEvent[] = mergedEvents.map((me, obsIndex) => {
    const perf = perfAt(obsIndex);
    const event: ScheduleEvent = { gridIndex: me.gridIndex, period: me.couponPeriod ?? me.callPeriod ?? 0 };

    if (me.couponPeriod !== undefined) {
      event.period = me.couponPeriod;
      if (spec.couponType === 'fixed') {
        event.coupon = { condition: alwaysTrue(), amount: konst(couponAmt), memory: false };
      } else {
        const barrier = spec.couponBarrierPct / 100;
        event.coupon = {
          condition: gte(perf, konst(barrier)),
          amount: konst(couponAmt),
          memory: spec.couponType === 'memory',
        };
      }
    }

    if (me.callPeriod !== undefined && isCallable(spec, me.callPeriod)) {
      event.period = me.callPeriod;
      const barrier = callBarrierDecimal(spec, me.callPeriod);
      event.autocall = {
        condition: gte(perf, konst(barrier)),
        redemption: konst(redemptionCostPctAt(spec, me.callPeriod)),
      };
    }

    return event;
  });

  const perfTNode = perfT();
  const kiCond: Cmp =
    spec.barrierType === 'none'
      ? alwaysTrue()
      : spec.barrierType === 'european'
        ? lt(perfTNode, konst(spec.kiBarrierPct / 100))
        : lt({ t: 'minPerf' }, konst(spec.kiBarrierPct / 100));

  const shortfall = max(konst(0), sub(konst(spec.putStrikePct), scale(perfTNode, 100)));
  const loss = scale(shortfall, spec.downsideLeveragePct / 100);
  const putLeg = max(konst(0), sub(konst(100), loss));
  const maturity: Expr = ite(kiCond, putLeg, konst(100));

  return {
    events,
    maturity,
    maturityGridIndex: grid.nSteps,
    maturityLifeYears: spec.tenorYears,
    reporting: spec.barrierType === 'none' ? undefined : { kiEvent: kiCond },
  };
}

// ---------------------------------------------------------------------------
// Participation booster (mirrors participation.ts).
// ---------------------------------------------------------------------------

export function buildParticipationBooster(spec: ParticipationSpec): Contract {
  const perfTNode = perfT();
  const upStrike = spec.upside.strikePct / 100;

  const effUpsidePerf: Expr =
    spec.upside.variant.variant === 'callSpread' ? cap(perfTNode, spec.upside.variant.upperStrikePct / 100) : perfTNode;
  // Matches makeParticipationEvaluator's exact op order — (participationPct/100)
  // * max(...) * 100 — rather than the mathematically-equivalent single
  // multiply by participationPct, to stay bit-for-bit identical (a single
  // fused multiply rounds differently in the last ULP).
  const upsideRaw = scale(
    scale(max(konst(0), sub(effUpsidePerf, konst(upStrike))), spec.upside.participationPct / 100),
    100,
  );

  let koCond: Cmp = { t: 'false' };
  let upsideAmt: Expr = upsideRaw;
  if (spec.upside.variant.variant === 'koRebate') {
    const v = spec.upside.variant;
    koCond = v.koMonitoring === 'european' ? gte(perfTNode, konst(v.koBarrierPct / 100)) : gte({ t: 'maxPerf' }, konst(v.koBarrierPct / 100));
    upsideAmt = ite(koCond, konst(v.rebatePct), upsideRaw);
  }

  const barrierType: BarrierMonitoring = spec.downside.barrierType;
  const isKiCond: Cmp =
    barrierType === 'none'
      ? alwaysTrue()
      : barrierType === 'european'
        ? lt(perfTNode, konst(spec.downside.kiBarrierPct / 100))
        : lt({ t: 'minPerf' }, konst(spec.downside.kiBarrierPct / 100));

  const dnStrike = spec.downside.strikePct / 100;
  // Same bit-exact-op-order note as upsideRaw above.
  const twinWinAmt = scale(scale(max(konst(0), sub(konst(dnStrike), perfTNode)), spec.downside.twinWinPct / 100), 100);
  const redemptionNotKi = max(add(konst(100), konst(spec.bonusPct)), add(add(konst(100), upsideAmt), twinWinAmt));

  const flooredPerf = spec.downside.putSpread
    ? eFloor(perfTNode, spec.downside.putSpread.lowerStrikePct / 100)
    : perfTNode;
  const loss = scale(max(konst(0), sub(konst(spec.downside.strikePct), scale(flooredPerf, 100))), spec.downside.leveragePct / 100);
  const redemptionKi = sub(add(konst(100), upsideAmt), loss);

  const redemption = ite(isKiCond, redemptionKi, redemptionNotKi);
  const maturity = max(max(redemption, konst(spec.protectionPct)), konst(0));

  return {
    events: [],
    maturity,
    maturityGridIndex: 0, // set by caller from grid.nSteps (see buildParticipationBoosterForGrid)
    maturityLifeYears: spec.tenorYears,
    reporting: {
      kiEvent: barrierType === 'none' ? undefined : isKiCond,
      upsideKoEvent: spec.upside.variant.variant === 'koRebate' ? koCond : undefined,
    },
  };
}

/** `buildParticipationBooster` doesn't need the grid to build the payoff
 * expression (participation only ever observes at nSteps), but discounting
 * needs to know that index — this wraps it in given the grid. */
export function buildParticipation(spec: ParticipationSpec, grid: PricingGrid): Contract {
  const c = buildParticipationBooster(spec);
  return { ...c, maturityGridIndex: grid.nSteps };
}

// ---------------------------------------------------------------------------
// Catapult: autocall schedule + geared upside participation (if never
// called) + downside protection floor. No hand-written oracle exists for
// this shape — tests/combinators.test.ts asserts sanity properties
// (monotonicity in the call barrier, protection floor holding) rather than
// per-path equivalence.
// ---------------------------------------------------------------------------

export interface CatapultTerms {
  tenorYears: number;
  callFrequency: Frequency;
  callFromPeriod: number;
  callBarrierPct: number;
  /** Snowball-style coupon paid on autocall: couponPaPct * period / periodsPerYear. */
  couponPaPct: number;
  participationPct: number;
  upsideStrikePct: number;
  protectionPct: number;
  downsideLeveragePct: number;
  putStrikePct: number;
  barrierType: BarrierMonitoring;
  kiBarrierPct: number;
}

function catapultObs(tenorYears: number, freq: Frequency, nSteps: number, dtYears: number): number[] {
  const periodsPerYear = PERIODS_PER_YEAR[freq];
  const numObs = Math.round(tenorYears * periodsPerYear);
  const indices: number[] = [];
  for (let k = 1; k <= numObs; k++) {
    const t = k / periodsPerYear;
    indices.push(Math.min(nSteps, Math.max(1, Math.round(t / dtYears))));
  }
  return Array.from(new Set(indices)).sort((a, b) => a - b);
}

export function buildCatapult(terms: CatapultTerms, grid: PricingGrid): Contract {
  const gridIndices = catapultObs(terms.tenorYears, terms.callFrequency, grid.nSteps, grid.dtYears);
  const periodsPerYear = PERIODS_PER_YEAR[terms.callFrequency];

  const events: ScheduleEvent[] = gridIndices.map((gi, obsIndex) => {
    const period = obsIndex + 1;
    const perf = perfAt(obsIndex);
    if (period < terms.callFromPeriod) return { gridIndex: gi, period };
    return {
      gridIndex: gi,
      period,
      autocall: {
        condition: gte(perf, konst(terms.callBarrierPct / 100)),
        redemption: konst(100 + (terms.couponPaPct * period) / periodsPerYear),
      },
    };
  });

  const perfTNode = perfT();
  const kiCond: Cmp =
    terms.barrierType === 'none'
      ? alwaysTrue()
      : terms.barrierType === 'european'
        ? lt(perfTNode, konst(terms.kiBarrierPct / 100))
        : lt({ t: 'minPerf' }, konst(terms.kiBarrierPct / 100));

  const shortfall = max(konst(0), sub(konst(terms.putStrikePct), scale(perfTNode, 100)));
  const loss = scale(shortfall, terms.downsideLeveragePct / 100);
  const downsideLeg: Expr = ite(kiCond, max(konst(0), sub(konst(100), loss)), konst(100));

  const upsideAmt = scale(max(konst(0), sub(perfTNode, konst(terms.upsideStrikePct / 100))), terms.participationPct);

  const maturity = max(konst(terms.protectionPct), add(downsideLeg, upsideAmt));

  return {
    events,
    maturity,
    maturityGridIndex: grid.nSteps,
    maturityLifeYears: terms.tenorYears,
    reporting: terms.barrierType === 'none' ? undefined : { kiEvent: kiCond },
  };
}
