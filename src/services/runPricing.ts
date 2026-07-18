import type { MarketData } from '../model/market';
import type { ProductSpec } from '../model/product';
import type { PriceRequest, SolveTarget } from '../model/request';
import { DEFAULT_MC } from '../model/request';
import { pricerClient } from '../worker/client';
import { useResultsStore } from '../state/resultsStore';
import { useHistoryStore } from '../state/historyStore';
import { useTradeStore, type PageId } from '../state/tradeStore';
import {
  accumulatorTermsSummary,
  couponTermsSummary,
  marketSummary,
  participationTermsSummary,
} from './summaries';

const SOLVE_LABELS: Record<SolveTarget['kind'], string> = {
  none: 'Price',
  couponPa: 'Coupon p.a.',
  acCouponPa: 'AC Coupon',
  couponBarrier: 'Coupon Barrier',
  callBarrier: 'Call Barrier',
  kiBarrier: 'KI Barrier',
  gearing: 'Upside participation',
  upsideStrike: 'Upside strike',
  downsideLeverage: 'Downside leverage',
  bonusLevel: 'Bonus',
  twinWin: 'Twin-win participation',
  upperStrike: 'Upper Strike',
  upsideKoBarrier: 'KO Barrier',
  rebate: 'Rebate',
  strike: 'Strike',
  upfront: 'Upfront',
};

function termsSummaryFor(product: ProductSpec): string {
  if (product.kind === 'coupon') return couponTermsSummary(product);
  if (product.kind === 'participation') return participationTermsSummary(product);
  return accumulatorTermsSummary(product);
}

/**
 * After a successful solve, write the solved value back into the relevant
 * spec field so the UI can render it read-only/dimmed as "last solved
 * value" per the design spec.
 */
function writeBackSolvedValue(
  product: ProductSpec,
  solve: SolveTarget,
  solvedValue: number | undefined
): void {
  if (solvedValue === undefined || solve.kind === 'none') return;
  // Round to 4 decimals for display in the form; the results panel keeps
  // the raw value.
  solvedValue = Math.round(solvedValue * 1e4) / 1e4;
  const trade = useTradeStore.getState();

  if (product.kind === 'coupon') {
    switch (solve.kind) {
      case 'couponPa':
        trade.setCouponSpec({ couponPaPct: solvedValue });
        break;
      case 'acCouponPa':
        trade.setCouponSpec({ acCouponPct: solvedValue });
        break;
      case 'couponBarrier':
        trade.setCouponSpec({ couponBarrierPct: solvedValue });
        break;
      case 'callBarrier':
        trade.setCouponSpec({ callBarrierPct: solvedValue });
        break;
      case 'kiBarrier':
        trade.setCouponSpec({ kiBarrierPct: solvedValue });
        break;
      default:
        break;
    }
    return;
  }

  if (product.kind === 'participation') {
    switch (solve.kind) {
      case 'gearing':
        trade.patchParticipationSpec({ upside: { ...product.upside, participationPct: solvedValue } });
        break;
      case 'upsideStrike':
        trade.patchParticipationSpec({ upside: { ...product.upside, strikePct: solvedValue } });
        break;
      case 'downsideLeverage':
        trade.patchParticipationSpec({ downside: { ...product.downside, leveragePct: solvedValue } });
        break;
      case 'kiBarrier':
        trade.patchParticipationSpec({ downside: { ...product.downside, kiBarrierPct: solvedValue } });
        break;
      case 'bonusLevel':
        trade.patchParticipationSpec({ bonusPct: solvedValue });
        break;
      case 'twinWin':
        trade.patchParticipationSpec({ downside: { ...product.downside, twinWinPct: solvedValue } });
        break;
      case 'upperStrike':
        if (product.upside.variant.variant === 'callSpread') {
          trade.patchParticipationSpec({
            upside: { ...product.upside, variant: { ...product.upside.variant, upperStrikePct: solvedValue } },
          });
        }
        break;
      case 'upsideKoBarrier':
        if (product.upside.variant.variant === 'koRebate') {
          trade.patchParticipationSpec({
            upside: { ...product.upside, variant: { ...product.upside.variant, koBarrierPct: solvedValue } },
          });
        }
        break;
      case 'rebate':
        if (product.upside.variant.variant === 'koRebate') {
          trade.patchParticipationSpec({
            upside: { ...product.upside, variant: { ...product.upside.variant, rebatePct: solvedValue } },
          });
        }
        break;
      default:
        break;
    }
    return;
  }

  // accumulator
  switch (solve.kind) {
    case 'strike':
      trade.setAccumulatorSpec({ strikePct: solvedValue });
      break;
    case 'upfront':
      trade.setAccumulatorSpec({ upfrontPct: solvedValue });
      break;
    default:
      break;
  }
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
    writeBackSolvedValue(product, solve, result.solvedValue);

    useHistoryStore.getState().addEntry({
      id,
      timestamp: Date.now(),
      page,
      termsSummary: termsSummaryFor(product),
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
