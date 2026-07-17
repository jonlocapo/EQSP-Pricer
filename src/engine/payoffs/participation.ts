import type { BarrierMonitoring, ParticipationSpec, UpsideVariant } from '../../model/product';
import type { EvaluatorContext, PathOutcome, PayoffEvaluator } from './types';
import { timeOf } from './types';

/**
 * Participation products decompose into an upside leg (subject to an upside
 * variant: vanilla / call spread / KO+rebate) and, where applicable, a
 * downside leg (subject to an optional put-spread floor).
 *
 * KO-rebate rule (documented per the spec author's instruction, since the
 * plain "replace the upside leg" description is ambiguous for the additive
 * subtypes): when the KO event fires, the *entire* variant-upside amount
 * that would otherwise be added on top of the base leg is replaced by the
 * flat `rebatePct`, i.e. `variantUpsideAmt := rebatePct` instead of the
 * usual `(effPerf(perf) - 1) * 100`-shaped term. Any pre-existing
 * gearing/participation multiplier that would normally scale that term is
 * NOT reapplied to the rebate — the rebate is the leg, verbatim. Downside /
 * protection / bonus-floor logic is computed independently of KO status.
 */

function evalKi(barrierType: BarrierMonitoring, kiBarrierPct: number, spots: Float64Array): boolean {
  const S0 = spots[0];
  const nSteps = spots.length - 1;
  if (barrierType === 'none') return true; // caller only invokes this when relevant
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
    const koEvent = evalKo(spec.upside, spots);
    let kiEvent: boolean | undefined;
    let redemptionPct: number;

    switch (spec.subtype) {
      case 'booster': {
        const strike = spec.strikePct / 100;
        const gearing = spec.gearingPct / 100;
        const effPerf = effUpsidePerf(spec.upside, perfT);
        const upsideLeg = koEvent
          ? spec.upside.variant === 'koRebate'
            ? spec.upside.rebatePct
            : 0
          : gearing * Math.max(0, effPerf - strike) * 100;

        const isKi = evalKi(spec.barrierType, spec.kiBarrierPct, spots);
        kiEvent = spec.barrierType === 'none' ? undefined : isKi;
        const exposed = spec.barrierType === 'none' || isKi;
        let downsideLeg = 0;
        if (exposed) {
          const downStrike = spec.downsideStrikePct / 100;
          const floored = effDownsidePerf(spec.downsidePutSpread?.lowerStrikePct, perfT);
          if (floored < downStrike) {
            downsideLeg = (spec.downsideLeveragePct / 100) * (downStrike - floored) * 100;
          }
        }
        redemptionPct = 100 + upsideLeg - downsideLeg;
        break;
      }

      case 'bonus': {
        const isKi = evalKi(spec.barrierType, spec.kiBarrierPct, spots);
        kiEvent = isKi;
        const effPerf = effUpsidePerf(spec.upside, perfT);
        const variantUpsideAmt = koEvent
          ? spec.upside.variant === 'koRebate'
            ? spec.upside.rebatePct
            : 0
          : (effPerf - 1) * 100;
        if (!isKi) {
          redemptionPct = Math.max(spec.bonusLevelPct, 100 + variantUpsideAmt);
        } else {
          const flooredPerf = effDownsidePerf(spec.downsidePutSpread?.lowerStrikePct, perfT);
          redemptionPct = Math.min(100 * flooredPerf, 100 + variantUpsideAmt);
        }
        break;
      }

      case 'capitalGuaranteed': {
        const strike = spec.strikePct / 100;
        const effPerf = effUpsidePerf(spec.upside, perfT);
        const upsideLeg = koEvent
          ? spec.upside.variant === 'koRebate'
            ? spec.upside.rebatePct
            : 0
          : (spec.participationPct / 100) * Math.max(0, effPerf - strike) * 100;
        kiEvent = undefined;
        redemptionPct = Math.max(spec.protectionPct, spec.protectionPct + upsideLeg);
        break;
      }

      case 'twinWin': {
        const isKi = evalKi(spec.barrierType, spec.kiBarrierPct, spots);
        kiEvent = isKi;
        const effPerf = effUpsidePerf(spec.upside, perfT);
        const upLeg = koEvent
          ? spec.upside.variant === 'koRebate'
            ? spec.upside.rebatePct
            : 0
          : (spec.partUpPct / 100) * Math.max(0, effPerf - 1) * 100;
        if (!isKi) {
          const flooredPerf = effDownsidePerf(spec.downsidePutSpread?.lowerStrikePct, perfT);
          const downLeg = (spec.partDownPct / 100) * Math.max(0, 1 - flooredPerf) * 100;
          redemptionPct = 100 + upLeg + downLeg;
        } else {
          const flooredPerf = effDownsidePerf(spec.downsidePutSpread?.lowerStrikePct, perfT);
          redemptionPct = Math.min(100 * flooredPerf, 100 + upLeg);
        }
        break;
      }
    }

    const T = timeOf(grid.nSteps, grid);
    return {
      pvPct: ctx.df(T) * redemptionPct,
      kiEvent,
      upsideKoEvent: spec.upside.variant === 'koRebate' ? koEvent : undefined,
      lifeYears: spec.tenorYears,
    };
  };
}
