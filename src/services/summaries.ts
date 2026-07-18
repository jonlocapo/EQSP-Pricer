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
  const parts = [
    `up ${fmtPct(spec.upside.strikePct)}/${fmtPct(spec.upside.participationPct)}`,
    `dn ${fmtPct(spec.downside.strikePct)}/${fmtPct(spec.downside.leveragePct)} (${spec.downside.barrierType})`,
  ];
  if (spec.downside.barrierType !== 'none') parts.push(`KI ${fmtPct(spec.downside.kiBarrierPct)}`);
  if (spec.downside.twinWinPct > 0) parts.push(`twinWin ${fmtPct(spec.downside.twinWinPct)}`);
  if (spec.bonusPct > 0) parts.push(`bonus +${fmtPct(spec.bonusPct)}`);
  if (spec.protectionPct > 0) parts.push(`prot ${fmtPct(spec.protectionPct)}`);
  return `participation · ${spec.tenorYears}y · ${parts.join(' · ')} · ${spec.upside.variant.variant}`;
}

export function accumulatorTermsSummary(spec: AccumulatorSpec): string {
  const tag = spec.direction === 'decumulate' ? 'DQ' : 'AQ';
  return `${tag} strike ${fmtPct(spec.strikePct)} trigger ${fmtPct(spec.koTriggerPct)} · ${spec.dailyShares}sh/day · ${spec.gearing}x · ${spec.tenorYears.toFixed(2)}y`;
}

export function marketSummary(market: MarketData, underlyingName: string): string {
  return `${underlyingName} ${market.currency} S=${market.spot} σ=${(market.vol * 100).toFixed(1)}% r=${(market.rate * 100).toFixed(2)}%`;
}
