import type { AccumulatorSpec, CouponProductSpec, ParticipationSpec } from '../model/product';
import type { MarketData } from '../model/market';

function fmtPct(v: number): string {
  return `${v}%`;
}

export function couponTermsSummary(spec: CouponProductSpec): string {
  const parts = [
    `${spec.tenorYears}y RC${spec.callType !== 'none' ? '/AC' : ''}`,
    `KI ${spec.barrierType === 'none' ? 'none' : fmtPct(spec.kiBarrierPct)}`,
    `cpn ${fmtPct(spec.couponPaPct)} p.a. (${spec.couponType})`,
  ];
  if (spec.callType !== 'none') parts.push(`call ${fmtPct(spec.callBarrierPct)} (${spec.callType})`);
  return parts.join(' · ');
}

export function participationTermsSummary(spec: ParticipationSpec): string {
  const head = spec.subtype;
  let body = '';
  switch (spec.subtype) {
    case 'booster':
      body = `strike ${fmtPct(spec.strikePct)} gearing ${fmtPct(spec.gearingPct)}`;
      break;
    case 'bonus':
      body = `bonus ${fmtPct(spec.bonusLevelPct)} KI ${fmtPct(spec.kiBarrierPct)}`;
      break;
    case 'capitalGuaranteed':
      body = `protection ${fmtPct(spec.protectionPct)} part ${fmtPct(spec.participationPct)}`;
      break;
    case 'twinWin':
      body = `up ${fmtPct(spec.partUpPct)} down ${fmtPct(spec.partDownPct)} KI ${fmtPct(spec.kiBarrierPct)}`;
      break;
  }
  return `${head} · ${spec.tenorYears}y · ${body} · ${spec.upside.variant}`;
}

export function accumulatorTermsSummary(spec: AccumulatorSpec): string {
  return `strike ${fmtPct(spec.strikePct)} trigger ${fmtPct(spec.koTriggerPct)} · ${spec.dailyShares}sh/day · ${spec.gearing}x · ${spec.tenorYears.toFixed(2)}y`;
}

export function marketSummary(market: MarketData, underlyingName: string): string {
  return `${underlyingName} ${market.currency} S=${market.spot} σ=${(market.vol * 100).toFixed(1)}% r=${(market.rate * 100).toFixed(2)}%`;
}
