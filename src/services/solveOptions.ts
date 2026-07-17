import type { CouponProductSpec, ParticipationSpec } from '../model/product';
import type { SolveTarget } from '../model/request';

export interface SolveOption {
  value: SolveTarget['kind'];
  label: string;
  disabled?: boolean;
  tooltip?: string;
}

export function couponSolveOptions(spec: CouponProductSpec): SolveOption[] {
  const issuerCallable = spec.callType === 'issuerCallable';
  const hint = issuerCallable ? 'LSMC pricing only supports Price in v1.' : undefined;

  const opts: SolveOption[] = [
    { value: 'none', label: 'Price (reoffer)' },
    { value: 'couponPa', label: 'Coupon p.a.', disabled: issuerCallable, tooltip: hint },
    {
      value: 'acCouponPa',
      label: 'AC Coupon p.a.',
      disabled: issuerCallable || spec.autocallCouponPaPct === 0,
      tooltip: issuerCallable ? hint : spec.autocallCouponPaPct === 0 ? 'Enable AC coupon first.' : undefined,
    },
    {
      value: 'couponBarrier',
      label: 'Coupon Barrier',
      disabled: issuerCallable || spec.couponType === 'fixed',
      tooltip: issuerCallable ? hint : spec.couponType === 'fixed' ? 'Not applicable to fixed coupons.' : undefined,
    },
    {
      value: 'callBarrier',
      label: 'Call Barrier',
      disabled: issuerCallable || !(spec.callType === 'constant' || spec.callType === 'stepdown'),
      tooltip: issuerCallable
        ? hint
        : spec.callType === 'constant' || spec.callType === 'stepdown'
          ? undefined
          : 'Only for constant/step-down call schedules.',
    },
    {
      value: 'kiBarrier',
      label: 'KI Barrier',
      disabled: issuerCallable || spec.barrierType === 'none',
      tooltip: issuerCallable ? hint : spec.barrierType === 'none' ? 'No knock-in barrier set.' : undefined,
    },
  ];
  return opts;
}

export function participationSolveOptions(spec: ParticipationSpec): SolveOption[] {
  const headline: SolveOption =
    spec.subtype === 'booster'
      ? { value: 'gearing', label: 'Gearing' }
      : spec.subtype === 'bonus'
        ? { value: 'bonusLevel', label: 'Bonus Level' }
        : spec.subtype === 'capitalGuaranteed'
          ? { value: 'participation', label: 'Participation' }
          : { value: 'partUp', label: 'Part Up' };

  const opts: SolveOption[] = [{ value: 'none', label: 'Price (reoffer)' }, headline];

  opts.push({
    value: 'upperStrike',
    label: 'Upper Strike',
    disabled: spec.upside.variant !== 'callSpread',
    tooltip: spec.upside.variant !== 'callSpread' ? 'Only for call-spread upside.' : undefined,
  });
  opts.push({
    value: 'upsideKoBarrier',
    label: 'KO Barrier',
    disabled: spec.upside.variant !== 'koRebate',
    tooltip: spec.upside.variant !== 'koRebate' ? 'Only for KO + rebate upside.' : undefined,
  });
  opts.push({
    value: 'rebate',
    label: 'Rebate',
    disabled: spec.upside.variant !== 'koRebate',
    tooltip: spec.upside.variant !== 'koRebate' ? 'Only for KO + rebate upside.' : undefined,
  });

  return opts;
}
