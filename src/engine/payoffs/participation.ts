import type { BarrierMonitoring, ParticipationSpec, UpsideVariant } from '../../model/product';
import type {
  EvaluatorContext,
  ObservablesEvaluator,
  OutcomeEvaluator,
  PathObservables,
  PathOutcome,
  PayoffEvaluator,
} from './types';
import { timeOf } from './types';

/**
 * Generic participation payoff: one upside leg + one downside leg + optional
 * bonus floor + optional protection floor. The four classic subtypes
 * (Booster, Bonus, Capital Guaranteed, Twin Win) are just presets of this
 * one shape (see tradeStore's participationPreset).
 *
 *   effPerf   = callSpread ? min(perf, upperStrike/100) : perf
 *   upsideAmt = participationPct/100 * max(0, effPerf - upStrike/100) * 100
 *   koRebate KO event -> upsideAmt := rebatePct (verbatim, not re-geared)
 *
 *   kiEvent   = barrierType 'none' -> always exposed (loss leg always live)
 *             | 'european' -> perf_T < kiBarrier/100
 *             | 'american' -> daily min perf < kiBarrier/100
 *
 *   NOT kiEvent (only reachable when barrierType !== 'none'):
 *     twinWinAmt = twinWinPct/100 * max(0, dnStrike/100 - perf) * 100
 *     red = max(100 + bonusPct, 100 + upsideAmt + twinWinAmt)
 *   else (KI'd, or barrierType 'none'):
 *     floorPerf  = putSpread ? max(perf, lowerStrike/100) : perf
 *     loss       = leveragePct/100 * max(0, dnStrikePct - 100*floorPerf)
 *     red        = 100 + upsideAmt - loss          (bonus / twin-win lost)
 *
 *   red = max(red, protectionPct, 0)
 *
 * kiEvent is reported on the outcome only when barrierType !== 'none'.
 */

function evalKi(barrierType: BarrierMonitoring, kiBarrierPct: number, spots: Float64Array): boolean {
  const S0 = spots[0];
  const nSteps = spots.length - 1;
  if (barrierType === 'none') return true; // always exposed
  if (barrierType === 'european') {
    return spots[nSteps] / S0 < kiBarrierPct / 100;
  }
  // american: min over all daily spots
  let minPerf = Infinity;
  for (let i = 1; i <= nSteps; i++) {
    const p = spots[i] / S0;
    if (p < minPerf) minPerf = p;
  }
  return minPerf < kiBarrierPct / 100;
}

function evalKo(upside: UpsideVariant, spots: Float64Array): boolean {
  if (upside.variant !== 'koRebate') return false;
  const S0 = spots[0];
  const nSteps = spots.length - 1;
  const barrier = upside.koBarrierPct / 100;
  if (upside.koMonitoring === 'european') {
    return spots[nSteps] / S0 >= barrier;
  }
  let maxPerf = -Infinity;
  for (let i = 1; i <= nSteps; i++) {
    const p = spots[i] / S0;
    if (p > maxPerf) maxPerf = p;
  }
  return maxPerf >= barrier;
}

/** perf as seen by upside terms: callSpread caps it at the upper strike. */
function effUpsidePerf(upside: UpsideVariant, perf: number): number {
  if (upside.variant === 'callSpread') return Math.min(perf, upside.upperStrikePct / 100);
  return perf;
}

/** perf as seen by downside-loss terms: put spread floors it at lowerStrikePct. */
function effDownsidePerf(lowerStrikePct: number | undefined, perf: number): number {
  if (lowerStrikePct === undefined) return perf;
  return Math.max(perf, lowerStrikePct / 100);
}

export function makeParticipationEvaluator(
  spec: ParticipationSpec,
  ctx: EvaluatorContext,
): PayoffEvaluator {
  const { grid } = ctx;

  return (spots: Float64Array): PathOutcome => {
    const S0 = spots[0];
    const perfT = spots[grid.nSteps] / S0;

    const koEvent = evalKo(spec.upside.variant, spots);
    const upStrike = spec.upside.strikePct / 100;
    const effPerf = effUpsidePerf(spec.upside.variant, perfT);
    let upsideAmt = (spec.upside.participationPct / 100) * Math.max(0, effPerf - upStrike) * 100;
    if (koEvent) {
      upsideAmt = spec.upside.variant.variant === 'koRebate' ? spec.upside.variant.rebatePct : 0;
    }

    const isKi = evalKi(spec.downside.barrierType, spec.downside.kiBarrierPct, spots);
    const kiEvent = spec.downside.barrierType === 'none' ? undefined : isKi;

    let redemptionPct: number;
    if (!isKi) {
      // Only reachable when barrierType !== 'none'.
      const dnStrike = spec.downside.strikePct / 100;
      const twinWinAmt = (spec.downside.twinWinPct / 100) * Math.max(0, dnStrike - perfT) * 100;
      redemptionPct = Math.max(100 + spec.bonusPct, 100 + upsideAmt + twinWinAmt);
    } else {
      const flooredPerf = effDownsidePerf(spec.downside.putSpread?.lowerStrikePct, perfT);
      const loss = (spec.downside.leveragePct / 100) * Math.max(0, spec.downside.strikePct - 100 * flooredPerf);
      redemptionPct = 100 + upsideAmt - loss;
    }

    redemptionPct = Math.max(redemptionPct, spec.protectionPct, 0);

    const T = timeOf(grid.nSteps, grid);
    return {
      pvPct: ctx.df(T) * redemptionPct,
      kiEvent,
      upsideKoEvent: spec.upside.variant.variant === 'koRebate' ? koEvent : undefined,
      lifeYears: spec.tenorYears,
    };
  };
}

// ---------------------------------------------------------------------------
// Observables split (Phase A / Phase B). Participation only ever observes at
// nSteps (couponObs = [nSteps], no call schedule), so Phase A is just the
// terminal/running perf functionals — no per-event array is needed (eventPerf
// stays empty). Mirrors makeParticipationEvaluator's arithmetic exactly; see
// tests/observables.test.ts for the per-path equivalence proof.
// ---------------------------------------------------------------------------

/** Phase A: terminal perf + running min/max perf, once per path. Does not
 * depend on `spec` — only on the path itself. */
export function makeParticipationObservables(): ObservablesEvaluator {
  return (spots: Float64Array): PathObservables => {
    const S0 = spots[0];
    const nSteps = spots.length - 1;
    let minPerf = Infinity;
    let maxPerf = -Infinity;
    for (let i = 1; i <= nSteps; i++) {
      const p = spots[i] / S0;
      if (p < minPerf) minPerf = p;
      if (p > maxPerf) maxPerf = p;
    }
    return { perfT: spots[nSteps] / S0, minPerf, maxPerf, eventPerf: new Float64Array(0) };
  };
}

function evalKoFromObs(upside: UpsideVariant, obs: PathObservables): boolean {
  if (upside.variant !== 'koRebate') return false;
  const barrier = upside.koBarrierPct / 100;
  return upside.koMonitoring === 'european' ? obs.perfT >= barrier : obs.maxPerf >= barrier;
}

function evalKiFromObs(barrierType: BarrierMonitoring, kiBarrierPct: number, obs: PathObservables): boolean {
  if (barrierType === 'none') return true; // always exposed
  if (barrierType === 'european') return obs.perfT < kiBarrierPct / 100;
  return obs.minPerf < kiBarrierPct / 100;
}

/** Phase B: apply spec terms to precomputed observables. Identical
 * arithmetic/order to makeParticipationEvaluator's per-path closure. */
export function makeParticipationOutcome(spec: ParticipationSpec, ctx: EvaluatorContext): OutcomeEvaluator {
  const { grid } = ctx;

  return (obs: PathObservables): PathOutcome => {
    const perfT = obs.perfT;

    const koEvent = evalKoFromObs(spec.upside.variant, obs);
    const upStrike = spec.upside.strikePct / 100;
    const effPerf = effUpsidePerf(spec.upside.variant, perfT);
    let upsideAmt = (spec.upside.participationPct / 100) * Math.max(0, effPerf - upStrike) * 100;
    if (koEvent) {
      upsideAmt = spec.upside.variant.variant === 'koRebate' ? spec.upside.variant.rebatePct : 0;
    }

    const isKi = evalKiFromObs(spec.downside.barrierType, spec.downside.kiBarrierPct, obs);
    const kiEvent = spec.downside.barrierType === 'none' ? undefined : isKi;

    let redemptionPct: number;
    if (!isKi) {
      const dnStrike = spec.downside.strikePct / 100;
      const twinWinAmt = (spec.downside.twinWinPct / 100) * Math.max(0, dnStrike - perfT) * 100;
      redemptionPct = Math.max(100 + spec.bonusPct, 100 + upsideAmt + twinWinAmt);
    } else {
      const flooredPerf = effDownsidePerf(spec.downside.putSpread?.lowerStrikePct, perfT);
      const loss = (spec.downside.leveragePct / 100) * Math.max(0, spec.downside.strikePct - 100 * flooredPerf);
      redemptionPct = 100 + upsideAmt - loss;
    }

    redemptionPct = Math.max(redemptionPct, spec.protectionPct, 0);

    const T = timeOf(grid.nSteps, grid);
    return {
      pvPct: ctx.df(T) * redemptionPct,
      kiEvent,
      upsideKoEvent: spec.upside.variant.variant === 'koRebate' ? koEvent : undefined,
      lifeYears: spec.tenorYears,
    };
  };
}
