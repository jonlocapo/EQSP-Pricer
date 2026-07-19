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
      label: 'AC Coupon',
      disabled: issuerCallable || spec.acCouponType === 'none',
      tooltip: issuerCallable ? hint : spec.acCouponType === 'none' ? 'Set AC coupon type first.' : undefined,
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
  const isCallSpread = spec.upside.variant.variant === 'callSpread';
  const isKoRebate = spec.upside.variant.variant === 'koRebate';
  const hasBarrier = spec.downside.barrierType !== 'none';

  const opts: SolveOption[] = [
    { value: 'none', label: 'Price (reoffer)' },
    { value: 'gearing', label: 'Upside participation' },
    { value: 'upsideStrike', label: 'Upside strike' },
    {
      value: 'kiBarrier',
      label: 'KI Barrier',
      disabled: !hasBarrier,
      tooltip: !hasBarrier ? 'No knock-in barrier set.' : undefined,
    },
    { value: 'bonusLevel', label: 'Bonus' },
    {
      value: 'twinWin',
      label: 'Twin-win participation',
      disabled: !hasBarrier,
      tooltip: !hasBarrier ? 'Twin-win only applies when a KI barrier is set.' : undefined,
    },
    {
      value: 'upperStrike',
      label: 'Upper Strike',
      disabled: !isCallSpread,
      tooltip: !isCallSpread ? 'Only for call-spread upside.' : undefined,
    },
    {
      value: 'upsideKoBarrier',
      label: 'KO Barrier',
      disabled: !isKoRebate,
      tooltip: !isKoRebate ? 'Only for KO + rebate upside.' : undefined,
    },
    {
      value: 'rebate',
      label: 'Rebate',
      disabled: !isKoRebate,
      tooltip: !isKoRebate ? 'Only for KO + rebate upside.' : undefined,
    },
  ];

  return opts;
}
