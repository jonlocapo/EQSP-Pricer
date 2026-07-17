import type { MarketData } from '../model/market';
import type { ProductSpec } from '../model/product';
import type { PriceRequest, SolveTarget } from '../model/request';
import { DEFAULT_MC } from '../model/request';
import { pricerClient } from '../worker/client';
import { useResultsStore } from '../state/resultsStore';
import { useHistoryStore } from '../state/historyStore';
import type { PageId } from '../state/tradeStore';
import {
  accumulatorTermsSummary,
  couponTermsSummary,
  marketSummary,
  participationTermsSummary,
} from './summaries';

const SOLVE_LABELS: Record<SolveTarget['kind'], string> = {
  none: 'Price',
  couponPa: 'Coupon p.a.',
  acCouponPa: 'AC Coupon p.a.',
  couponBarrier: 'Coupon Barrier',
  callBarrier: 'Call Barrier',
  kiBarrier: 'KI Barrier',
  gearing: 'Gearing',
  bonusLevel: 'Bonus Level',
  participation: 'Participation',
  partUp: 'Part Up',
  upperStrike: 'Upper Strike',
  upsideKoBarrier: 'KO Barrier',
  rebate: 'Rebate',
  strike: 'Strike',
  upfront: 'Upfront',
};

function termsSummaryFor(page: PageId, product: ProductSpec): string {
  if (product.kind === 'coupon') return couponTermsSummary(product);
  if (product.kind === 'participation') return participationTermsSummary(product);
  return accumulatorTermsSummary(product);
}

export interface RunPricingParams {
  page: PageId;
  product: ProductSpec;
  market: MarketData;
  underlyingName: string;
  solve: SolveTarget;
  greeks: boolean;
}

export async function runPricing({
  page,
  product,
  market,
  underlyingName,
  solve,
  greeks,
}: RunPricingParams): Promise<void> {
  const id = crypto.randomUUID();
  const req: PriceRequest = {
    id,
    product,
    market,
    mc: DEFAULT_MC,
    solve,
    greeks,
  };

  const results = useResultsStore.getState();
  results.startRun(id);

  try {
    const result = await pricerClient.price(req, (p) => {
      useResultsStore.getState().setProgress(p);
    });
    useResultsStore.getState().finishRun(result);

    useHistoryStore.getState().addEntry({
      id,
      timestamp: Date.now(),
      page,
      termsSummary: termsSummaryFor(page, product),
      marketSummary: marketSummary(market, underlyingName),
      pvPct: result.pvPct,
      solvedValue: result.solvedValue,
      solveLabel: solve.kind !== 'none' ? SOLVE_LABELS[solve.kind] : undefined,
      product,
      market,
      underlyingName,
      solve,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'cancelled') {
      useResultsStore.getState().cancelRun();
    } else {
      useResultsStore.getState().failRun(err instanceof Error ? err.message : 'Pricing failed.');
    }
  }
}

export function cancelPricing(): void {
  const { runId } = useResultsStore.getState();
  if (runId) {
    pricerClient.cancel(runId);
  }
}
