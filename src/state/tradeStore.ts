import { create } from 'zustand';
import type {
  AccumulatorSpec,
  BonusSpec,
  BoosterSpec,
  CapitalGuaranteedSpec,
  CouponProductSpec,
  ParticipationSubtype,
  TwinWinSpec,
} from '../model/product';
import type { SolveTarget } from '../model/request';

export type PageId = 'coupon' | 'participation' | 'accumulator';

function callObservationCount(spec: CouponProductSpec): number {
  const perYear = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 }[spec.callFrequency];
  return Math.max(1, Math.round(spec.tenorYears * perYear));
}

export function rebuildCustomCallSchedule(
  spec: CouponProductSpec,
  fallbackBarrier?: number
): number[] {
  const n = callObservationCount(spec);
  const prev = spec.customCallBarriersPct;
  const fill = fallbackBarrier ?? spec.callBarrierPct;
  return Array.from({ length: n }, (_, i) => prev[i] ?? fill);
}

export const DEFAULT_COUPON_SPEC: CouponProductSpec = {
  kind: 'coupon',
  underlyings: [{ name: 'SPX Index' }],
  currency: 'EUR',
  notional: 1_000_000,
  tenorYears: 1,
  reofferPct: 98.5,
  issuePricePct: 100,

  barrierType: 'european',
  kiBarrierPct: 60,
  putStrikePct: 100,
  downsideLeveragePct: 100,

  callType: 'constant',
  callFrequency: 'quarterly',
  callFromPeriod: 1,
  callBarrierPct: 100,
  stepDownPct: 1,
  customCallBarriersPct: [100, 100, 100, 100],

  couponType: 'conditional',
  couponFrequency: 'quarterly',
  couponBarrierPct: 60,
  couponPaPct: 8,

  acCouponType: 'none',
  acCouponPct: 0,
};

const commonDefaults = {
  underlyings: [{ name: 'SPX Index' }],
  currency: 'EUR',
  notional: 1_000_000,
  tenorYears: 1,
  reofferPct: 100,
  issuePricePct: 100,
};

export const DEFAULT_BOOSTER: BoosterSpec = {
  ...commonDefaults,
  kind: 'participation',
  subtype: 'booster',
  upside: { variant: 'vanilla' },
  strikePct: 100,
  gearingPct: 150,
  downsideStrikePct: 100,
  downsideLeveragePct: 100,
  barrierType: 'none',
  kiBarrierPct: 60,
};

export const DEFAULT_BONUS: BonusSpec = {
  ...commonDefaults,
  kind: 'participation',
  subtype: 'bonus',
  upside: { variant: 'vanilla' },
  bonusLevelPct: 115,
  barrierType: 'american',
  kiBarrierPct: 65,
};

export const DEFAULT_CAP_GUARANTEED: CapitalGuaranteedSpec = {
  ...commonDefaults,
  kind: 'participation',
  subtype: 'capitalGuaranteed',
  upside: { variant: 'vanilla' },
  protectionPct: 100,
  strikePct: 100,
  participationPct: 100,
};

export const DEFAULT_TWIN_WIN: TwinWinSpec = {
  ...commonDefaults,
  kind: 'participation',
  subtype: 'twinWin',
  upside: { variant: 'vanilla' },
  partUpPct: 100,
  partDownPct: 100,
  barrierType: 'american',
  kiBarrierPct: 65,
};

export const DEFAULT_ACCUMULATOR: AccumulatorSpec = {
  kind: 'accumulator',
  direction: 'accumulate',
  underlyings: [{ name: 'SPX Index' }],
  currency: 'EUR',
  strikePct: 100,
  upfrontPct: 0.5,
  tenorYears: 0.5,
  settlementFrequency: 'monthly',
  dailyShares: 10,
  koTriggerPct: 110,
  koSettlement: 'ko1',
  gearing: 2,
  guaranteePeriods: 0,
};

export interface ParticipationDrafts {
  booster: BoosterSpec;
  bonus: BonusSpec;
  capitalGuaranteed: CapitalGuaranteedSpec;
  twinWin: TwinWinSpec;
}

interface TradeState {
  activePage: PageId;
  setActivePage: (p: PageId) => void;

  couponSpec: CouponProductSpec;
  couponSolve: SolveTarget;
  setCouponSpec: (patch: Partial<CouponProductSpec>) => void;
  setCouponSolve: (s: SolveTarget) => void;
  replaceCouponSpec: (spec: CouponProductSpec) => void;

  participationSubtype: ParticipationSubtype;
  participationDrafts: ParticipationDrafts;
  participationSolve: SolveTarget;
  setParticipationSubtype: (t: ParticipationSubtype) => void;
  patchParticipationDraft: <K extends ParticipationSubtype>(
    subtype: K,
    patch: Partial<ParticipationDrafts[K]>
  ) => void;
  setParticipationSolve: (s: SolveTarget) => void;
  replaceParticipationDraft: (spec: ParticipationDrafts[ParticipationSubtype]) => void;

  accumulatorSpec: AccumulatorSpec;
  accumulatorSolve: SolveTarget;
  setAccumulatorSpec: (patch: Partial<AccumulatorSpec>) => void;
  setAccumulatorSolve: (s: SolveTarget) => void;
  replaceAccumulatorSpec: (spec: AccumulatorSpec) => void;
}

export const useTradeStore = create<TradeState>((set) => ({
  activePage: 'coupon',
  setActivePage: (p) => set({ activePage: p }),

  couponSpec: DEFAULT_COUPON_SPEC,
  couponSolve: { kind: 'none' },
  setCouponSpec: (patch) => set((s) => ({ couponSpec: { ...s.couponSpec, ...patch } })),
  setCouponSolve: (couponSolve) => set({ couponSolve }),
  replaceCouponSpec: (couponSpec) => set({ couponSpec, couponSolve: { kind: 'none' } }),

  participationSubtype: 'booster',
  participationDrafts: {
    booster: DEFAULT_BOOSTER,
    bonus: DEFAULT_BONUS,
    capitalGuaranteed: DEFAULT_CAP_GUARANTEED,
    twinWin: DEFAULT_TWIN_WIN,
  },
  participationSolve: { kind: 'none' },
  setParticipationSubtype: (participationSubtype) => set({ participationSubtype }),
  patchParticipationDraft: (subtype, patch) =>
    set((s) => ({
      participationDrafts: {
        ...s.participationDrafts,
        [subtype]: { ...s.participationDrafts[subtype], ...patch },
      },
    })),
  setParticipationSolve: (participationSolve) => set({ participationSolve }),
  replaceParticipationDraft: (spec) =>
    set((s) => ({
      participationSubtype: spec.subtype,
      participationDrafts: { ...s.participationDrafts, [spec.subtype]: spec },
      participationSolve: { kind: 'none' },
    })),

  accumulatorSpec: DEFAULT_ACCUMULATOR,
  accumulatorSolve: { kind: 'strike' },
  setAccumulatorSpec: (patch) => set((s) => ({ accumulatorSpec: { ...s.accumulatorSpec, ...patch } })),
  setAccumulatorSolve: (accumulatorSolve) => set({ accumulatorSolve }),
  replaceAccumulatorSpec: (accumulatorSpec) => set({ accumulatorSpec }),
}));
