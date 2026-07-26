/**
 * The grid parameter registry. `ProductSpec` is a discriminated union, and
 * every page today wires each spec field by hand (`setSpec({ kiBarrierPct: v
 * })`). The pricing grid needs to address a field GENERICALLY: read its
 * current value from a spec, and write a new value into a copy of a spec,
 * for any field a desk might put on a grid axis. This module is the one
 * place that mapping lives.
 *
 * Each `GridParam` names one field. `read` gets the field's current value.
 * `write` returns a NEW spec with that field set to a new value; it never
 * mutates its argument. The grid builds many throwaway specs per solve, and
 * must never touch the live trade spec sitting in `tradeStore`.
 */

import type {
  AccumulatorSpec,
  CouponProductSpec,
  ParticipationSpec,
  ProductSpec,
} from './product';
import type { SolveTarget } from './request';

export interface GridParam {
  /** Stable id, for example 'coupon.kiBarrierPct'. Unique within a family. */
  key: string;
  /** Short label for the axis dropdown, for example 'KI barrier'. */
  label: string;
  unit: '%' | 'x' | '';
  /** Matches the step the product page uses for this field's NumericField,
   * so the grid axis rounds the same way the form does. */
  step: number;
  read: (spec: ProductSpec) => number;
  write: (spec: ProductSpec, v: number) => ProductSpec;
  /**
   * The solve target that WRITES this same field, when one exists.
   *
   * The grid must never put a field on an axis and solve for it at the same
   * time: the solver would overwrite the axis value, so the header would
   * claim a level the cell was not priced at. The setup row uses this to keep
   * the axis pickers and the solve-for picker mutually exclusive.
   *
   * Note that the 'none' target, plain Price, writes its answer into the
   * REOFFER (into the upfront for an accumulator), so those fields carry a
   * solveKind too even though Price is not a field solve.
   */
  solveKind?: SolveTarget['kind'];
}

function asCoupon(spec: ProductSpec, key: string): CouponProductSpec {
  if (spec.kind !== 'coupon') {
    throw new Error(`paramRegistry: '${key}' called on a non-coupon spec.`);
  }
  return spec;
}

function asParticipation(spec: ProductSpec, key: string): ParticipationSpec {
  if (spec.kind !== 'participation') {
    throw new Error(`paramRegistry: '${key}' called on a non-participation spec.`);
  }
  return spec;
}

function asAccumulator(spec: ProductSpec, key: string): AccumulatorSpec {
  if (spec.kind !== 'accumulator') {
    throw new Error(`paramRegistry: '${key}' called on a non-accumulator spec.`);
  }
  return spec;
}

const COUPON_PARAMS: GridParam[] = [
  {
    key: 'coupon.kiBarrierPct',
    solveKind: 'kiBarrier',
    label: 'KI barrier',
    unit: '%',
    step: 1,
    read: (s) => asCoupon(s, 'coupon.kiBarrierPct').kiBarrierPct,
    write: (s, v) => ({ ...asCoupon(s, 'coupon.kiBarrierPct'), kiBarrierPct: v }),
  },
  {
    key: 'coupon.putStrikePct',
    solveKind: 'putStrike',
    label: 'Put strike',
    unit: '%',
    step: 1,
    read: (s) => asCoupon(s, 'coupon.putStrikePct').putStrikePct,
    write: (s, v) => ({ ...asCoupon(s, 'coupon.putStrikePct'), putStrikePct: v }),
  },
  {
    key: 'coupon.couponPaPct',
    solveKind: 'couponPa',
    label: 'Coupon p.a.',
    unit: '%',
    step: 0.1,
    read: (s) => asCoupon(s, 'coupon.couponPaPct').couponPaPct,
    write: (s, v) => ({ ...asCoupon(s, 'coupon.couponPaPct'), couponPaPct: v }),
  },
  {
    key: 'coupon.couponBarrierPct',
    solveKind: 'couponBarrier',
    label: 'Coupon barrier',
    unit: '%',
    step: 1,
    read: (s) => asCoupon(s, 'coupon.couponBarrierPct').couponBarrierPct,
    write: (s, v) => ({ ...asCoupon(s, 'coupon.couponBarrierPct'), couponBarrierPct: v }),
  },
  {
    key: 'coupon.callBarrierPct',
    solveKind: 'callBarrier',
    label: 'Call barrier',
    unit: '%',
    step: 1,
    read: (s) => asCoupon(s, 'coupon.callBarrierPct').callBarrierPct,
    write: (s, v) => ({ ...asCoupon(s, 'coupon.callBarrierPct'), callBarrierPct: v }),
  },
  {
    key: 'coupon.stepDownPct',
    label: 'Step-down',
    unit: '%',
    step: 0.5,
    read: (s) => asCoupon(s, 'coupon.stepDownPct').stepDownPct,
    write: (s, v) => ({ ...asCoupon(s, 'coupon.stepDownPct'), stepDownPct: v }),
  },
  {
    key: 'coupon.acCouponPct',
    solveKind: 'acCouponPa',
    label: 'AC coupon',
    unit: '%',
    step: 0.1,
    read: (s) => asCoupon(s, 'coupon.acCouponPct').acCouponPct,
    write: (s, v) => ({ ...asCoupon(s, 'coupon.acCouponPct'), acCouponPct: v }),
  },
  {
    key: 'coupon.reofferPct',
    solveKind: 'none',
    label: 'Reoffer',
    unit: '%',
    step: 0.1,
    read: (s) => asCoupon(s, 'coupon.reofferPct').reofferPct,
    write: (s, v) => ({ ...asCoupon(s, 'coupon.reofferPct'), reofferPct: v }),
  },
  {
    key: 'coupon.downsideLeveragePct',
    label: 'Downside leverage',
    unit: '%',
    step: 5,
    read: (s) => asCoupon(s, 'coupon.downsideLeveragePct').downsideLeveragePct,
    write: (s, v) => ({ ...asCoupon(s, 'coupon.downsideLeveragePct'), downsideLeveragePct: v }),
  },
];

const PARTICIPATION_PARAMS: GridParam[] = [
  {
    key: 'participation.upsideStrikePct',
    solveKind: 'upsideStrike',
    label: 'Upside strike',
    unit: '%',
    step: 1,
    read: (s) => asParticipation(s, 'participation.upsideStrikePct').upside.strikePct,
    write: (s, v) => {
      const p = asParticipation(s, 'participation.upsideStrikePct');
      return { ...p, upside: { ...p.upside, strikePct: v } };
    },
  },
  {
    key: 'participation.participationPct',
    solveKind: 'gearing',
    label: 'Participation',
    unit: '%',
    step: 5,
    read: (s) => asParticipation(s, 'participation.participationPct').upside.participationPct,
    write: (s, v) => {
      const p = asParticipation(s, 'participation.participationPct');
      return { ...p, upside: { ...p.upside, participationPct: v } };
    },
  },
  {
    // The cap only means something under the call-spread upside variant, so
    // writing it also switches the variant to 'callSpread'. Any other variant
    // has no upper strike field at all.
    key: 'participation.upperStrikePct',
    solveKind: 'upperStrike',
    label: 'Cap',
    unit: '%',
    step: 1,
    read: (s) => {
      const p = asParticipation(s, 'participation.upperStrikePct');
      return p.upside.variant.variant === 'callSpread'
        ? p.upside.variant.upperStrikePct
        : p.upside.strikePct + 20;
    },
    write: (s, v) => {
      const p = asParticipation(s, 'participation.upperStrikePct');
      return { ...p, upside: { ...p.upside, variant: { variant: 'callSpread', upperStrikePct: v } } };
    },
  },
  {
    key: 'participation.kiBarrierPct',
    label: 'KI barrier',
    unit: '%',
    step: 1,
    read: (s) => asParticipation(s, 'participation.kiBarrierPct').downside.kiBarrierPct,
    write: (s, v) => {
      const p = asParticipation(s, 'participation.kiBarrierPct');
      return { ...p, downside: { ...p.downside, kiBarrierPct: v } };
    },
  },
  {
    key: 'participation.downsideStrikePct',
    label: 'Downside strike',
    unit: '%',
    step: 1,
    read: (s) => asParticipation(s, 'participation.downsideStrikePct').downside.strikePct,
    write: (s, v) => {
      const p = asParticipation(s, 'participation.downsideStrikePct');
      return { ...p, downside: { ...p.downside, strikePct: v } };
    },
  },
  {
    key: 'participation.bonusPct',
    solveKind: 'bonusLevel',
    label: 'Bonus',
    unit: '%',
    step: 1,
    read: (s) => asParticipation(s, 'participation.bonusPct').bonusPct,
    write: (s, v) => ({ ...asParticipation(s, 'participation.bonusPct'), bonusPct: v }),
  },
  {
    key: 'participation.protectionPct',
    label: 'Protection',
    unit: '%',
    step: 1,
    read: (s) => asParticipation(s, 'participation.protectionPct').protectionPct,
    write: (s, v) => ({ ...asParticipation(s, 'participation.protectionPct'), protectionPct: v }),
  },
  {
    key: 'participation.twinWinPct',
    solveKind: 'twinWin',
    label: 'Twin-win',
    unit: '%',
    step: 5,
    read: (s) => asParticipation(s, 'participation.twinWinPct').downside.twinWinPct,
    write: (s, v) => {
      const p = asParticipation(s, 'participation.twinWinPct');
      return { ...p, downside: { ...p.downside, twinWinPct: v } };
    },
  },
  {
    key: 'participation.reofferPct',
    solveKind: 'none',
    label: 'Reoffer',
    unit: '%',
    step: 0.1,
    read: (s) => asParticipation(s, 'participation.reofferPct').reofferPct,
    write: (s, v) => ({ ...asParticipation(s, 'participation.reofferPct'), reofferPct: v }),
  },
];

const ACCUMULATOR_PARAMS: GridParam[] = [
  {
    key: 'accumulator.strikePct',
    solveKind: 'strike',
    label: 'Strike',
    unit: '%',
    step: 1,
    read: (s) => asAccumulator(s, 'accumulator.strikePct').strikePct,
    write: (s, v) => ({ ...asAccumulator(s, 'accumulator.strikePct'), strikePct: v }),
  },
  {
    key: 'accumulator.koTriggerPct',
    solveKind: 'koTrigger',
    label: 'KO trigger',
    unit: '%',
    step: 1,
    read: (s) => asAccumulator(s, 'accumulator.koTriggerPct').koTriggerPct,
    write: (s, v) => ({ ...asAccumulator(s, 'accumulator.koTriggerPct'), koTriggerPct: v }),
  },
  {
    key: 'accumulator.upfrontPct',
    solveKind: 'upfront',
    label: 'Upfront',
    unit: '%',
    step: 0.1,
    read: (s) => asAccumulator(s, 'accumulator.upfrontPct').upfrontPct,
    write: (s, v) => ({ ...asAccumulator(s, 'accumulator.upfrontPct'), upfrontPct: v }),
  },
  {
    key: 'accumulator.dailyShares',
    label: 'Daily shares',
    unit: '',
    step: 1,
    read: (s) => asAccumulator(s, 'accumulator.dailyShares').dailyShares,
    write: (s, v) => ({ ...asAccumulator(s, 'accumulator.dailyShares'), dailyShares: v }),
  },
  {
    key: 'accumulator.guaranteePeriods',
    label: 'Guarantee periods',
    unit: '',
    step: 1,
    read: (s) => asAccumulator(s, 'accumulator.guaranteePeriods').guaranteePeriods,
    write: (s, v) => ({ ...asAccumulator(s, 'accumulator.guaranteePeriods'), guaranteePeriods: v }),
  },
];

/** Returns the grid-flexable fields for one product kind. The Lab's block
 * spec is out of scope for the grid, so 'lab' returns an empty list. */
export function gridParamsFor(kind: ProductSpec['kind']): GridParam[] {
  switch (kind) {
    case 'coupon':
      return COUPON_PARAMS;
    case 'participation':
      return PARTICIPATION_PARAMS;
    case 'accumulator':
      return ACCUMULATOR_PARAMS;
    case 'lab':
      return [];
  }
}
