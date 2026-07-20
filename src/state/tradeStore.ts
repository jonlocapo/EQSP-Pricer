import { create } from 'zustand';
import type {
  AccumulatorSpec,
  CouponProductSpec,
  ParticipationSpec,
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

/** Standard downside leverage: 1/downsideStrike so a 100% stock decline exhausts the leg. */
function autoDownsideLeverage(downsideStrikePct: number): number {
  if (!(downsideStrikePct > 0)) return 100;
  return Math.round((10000 / downsideStrikePct) * 100) / 100;
}

export type ParticipationPreset = 'booster' | 'bonus' | 'capitalGuaranteed' | 'twinWin' | 'twkg';

export const PARTICIPATION_PRESET_LABELS: Record<ParticipationPreset, string> = {
  booster: 'Booster',
  bonus: 'Bonus',
  capitalGuaranteed: 'Capital Guaranteed',
  twinWin: 'Twin Win',
  twkg: 'TWKG',
};

/**
 * Presets are UI prefills for the one generic ParticipationSpec shape, not
 * separate model shapes. CommonTerms (notional/tenor/reoffer/...) are left
 * untouched by presets — only the participation-specific fields below.
 */
export function participationPreset(
  preset: ParticipationPreset,
  common: Pick<ParticipationSpec, keyof typeof commonDefaults>
): ParticipationSpec {
  const base = { ...common, kind: 'participation' as const };
  switch (preset) {
    case 'booster':
      return {
        ...base,
        upside: { strikePct: 100, participationPct: 150, variant: { variant: 'vanilla' } },
        downside: {
          strikePct: 100,
          leveragePct: autoDownsideLeverage(100),
          barrierType: 'none',
          kiBarrierPct: 60,
          twinWinPct: 0,
        },
        bonusPct: 0,
        protectionPct: 0,
      };
    case 'bonus':
      return {
        ...base,
        upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
        downside: {
          strikePct: 100,
          leveragePct: autoDownsideLeverage(100),
          barrierType: 'american',
          kiBarrierPct: 65,
          twinWinPct: 0,
        },
        bonusPct: 5,
        protectionPct: 0,
      };
    case 'capitalGuaranteed':
      return {
        ...base,
        upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
        downside: {
          strikePct: 100,
          leveragePct: 0,
          barrierType: 'none',
          kiBarrierPct: 60,
          twinWinPct: 0,
        },
        bonusPct: 0,
        protectionPct: 100,
      };
    case 'twinWin':
      return {
        ...base,
        upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
        downside: {
          strikePct: 100,
          leveragePct: autoDownsideLeverage(100),
          barrierType: 'american',
          kiBarrierPct: 65,
          twinWinPct: 100,
        },
        bonusPct: 0,
        protectionPct: 0,
      };
    case 'twkg':
      return {
        ...base,
        upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
        downside: {
          strikePct: 100,
          leveragePct: autoDownsideLeverage(100),
          barrierType: 'american',
          kiBarrierPct: 65,
          twinWinPct: 100,
        },
        bonusPct: 0,
        protectionPct: 90,
      };
  }
}

export const DEFAULT_PARTICIPATION: ParticipationSpec = participationPreset('booster', commonDefaults);

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

interface TradeState {
  activePage: PageId;
  setActivePage: (p: PageId) => void;

  couponSpec: CouponProductSpec;
  couponSolve: SolveTarget;
  setCouponSpec: (patch: Partial<CouponProductSpec>) => void;
  setCouponSolve: (s: SolveTarget) => void;
  replaceCouponSpec: (spec: CouponProductSpec) => void;

  participationSpec: ParticipationSpec;
  participationSolve: SolveTarget;
  patchParticipationSpec: (patch: Partial<ParticipationSpec>) => void;
  setParticipationSolve: (s: SolveTarget) => void;
  replaceParticipationSpec: (spec: ParticipationSpec) => void;
  applyParticipationPreset: (preset: ParticipationPreset) => void;

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
  // Merge OVER the default spec: older localStorage history entries (or
  // anything predating a model field addition) won't carry newer fields,
  // so defaults backfill anything missing from the restored spec.
  replaceCouponSpec: (couponSpec) =>
    set({ couponSpec: { ...DEFAULT_COUPON_SPEC, ...couponSpec }, couponSolve: { kind: 'none' } }),

  participationSpec: DEFAULT_PARTICIPATION,
  participationSolve: { kind: 'none' },
  patchParticipationSpec: (patch) => set((s) => ({ participationSpec: { ...s.participationSpec, ...patch } })),
  setParticipationSolve: (participationSolve) => set({ participationSolve }),
  // Merge OVER the default spec, and shape-check first: older localStorage
  // history entries predate the generic-spec redesign entirely (they carried
  // a `subtype` and flat fields instead of nested upside/downside), so a
  // naive merge would silently mix incompatible shapes. Fall back to
  // defaults rather than let a malformed restore crash the history modal.
  replaceParticipationSpec: (spec) =>
    set(() => {
      try {
        const raw = spec as unknown as Record<string, unknown>;
        const upside = raw.upside as Record<string, unknown> | undefined;
        const downside = raw.downside as Record<string, unknown> | undefined;
        const looksValid =
          raw &&
          raw.kind === 'participation' &&
          typeof upside === 'object' &&
          upside !== null &&
          typeof (upside as { variant?: unknown }).variant === 'object' &&
          typeof downside === 'object' &&
          downside !== null;
        if (!looksValid) throw new Error('legacy/incompatible participation spec shape');
        const merged: ParticipationSpec = {
          ...DEFAULT_PARTICIPATION,
          ...spec,
          upside: { ...DEFAULT_PARTICIPATION.upside, ...spec.upside },
          downside: { ...DEFAULT_PARTICIPATION.downside, ...spec.downside },
        };
        return { participationSpec: merged, participationSolve: { kind: 'none' } };
      } catch {
        return { participationSpec: DEFAULT_PARTICIPATION, participationSolve: { kind: 'none' } };
      }
    }),
  applyParticipationPreset: (preset) =>
    set((s) => ({
      participationSpec: participationPreset(preset, s.participationSpec),
      participationSolve: { kind: 'none' },
    })),

  accumulatorSpec: DEFAULT_ACCUMULATOR,
  accumulatorSolve: { kind: 'strike' },
  setAccumulatorSpec: (patch) => set((s) => ({ accumulatorSpec: { ...s.accumulatorSpec, ...patch } })),
  setAccumulatorSolve: (accumulatorSolve) => set({ accumulatorSolve }),
  replaceAccumulatorSpec: (accumulatorSpec) =>
    set({ accumulatorSpec: { ...DEFAULT_ACCUMULATOR, ...accumulatorSpec } }),
}));
