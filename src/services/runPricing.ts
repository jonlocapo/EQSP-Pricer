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
  /** Fast, transient pass at reduced path count (see PriceRequest.preview).
   * Defaults to false (full-precision). */
  preview?: boolean;
  /** Seeds the solver's warm-start bracket with a previously solved value —
   * typically the last committed solvedValue, so a live re-solve converges
   * in a couple of iterations instead of cold-starting. */
  warmStartValue?: number;
  /** Whether this run gets recorded to the trade history log. Live-solve
   * (preview and debounced-settle) passes false so rapid edits don't flood
   * history — only the explicit Price/Solve button records an entry.
   * Defaults to true. */
  addToHistory?: boolean;
  /** True for a run auto-triggered by useLiveReprice (no button press).
   * Changes only how a failure is handled: a live pass that fails because
   * the solve bracket has no reachable root is a calm, expected outcome
   * while the user is mid-edit — it sets the soft `liveUnsolvable` state
   * and keeps the last good result, instead of flipping the panel into the
   * alarming red error state reserved for explicit button presses. Any
   * other failure (unexpected error) still surfaces as a normal error even
   * on a live pass. Defaults to false. */
  live?: boolean;
}

/** Matches the asyncRootFind "bracket doesn't contain a root" message
 * (src/worker/pricing.ts) — the one failure mode that's an expected,
 * calm outcome during live editing rather than a real error. */
const NO_SOLUTION_RE = /no solution .* not reachable/i;

export async function runPricing({
  page,
  product,
  market,
  underlyingName,
  solve,
  greeks,
  preview = false,
  warmStartValue,
  addToHistory = true,
  live = false,
}: RunPricingParams): Promise<void> {
  const id = crypto.randomUUID();
  const req: PriceRequest = {
    id,
    product,
    market,
    mc: DEFAULT_MC,
    solve,
    greeks,
    preview,
    warmStartValue,
  };

  const results = useResultsStore.getState();
  results.startRun(id);

  try {
    const result = await pricerClient.price(req, (p) => {
      useResultsStore.getState().setProgress(p);
    });
    useResultsStore.getState().finishRun(result);
    writeBackSolvedValue(product, solve, result.solvedValue);

    if (addToHistory) {
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
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pricing failed.';
    if (err instanceof Error && message === 'cancelled') {
      // Cancelled — a newer run superseded this one; not a failure at all.
      useResultsStore.getState().cancelRun();
    } else if (live && NO_SOLUTION_RE.test(message)) {
      // Expected, calm outcome while editing live into an unreachable
      // bracket — keep the last good result on screen, just flag it stale.
      useResultsStore.getState().failLiveRun('No solution at current terms.');
    } else {
      // Explicit failure (button press) or an unexpected error even on a
      // live pass — the normal, clearly-flagged error state.
      useResultsStore.getState().failRun(message);
    }
  }
}

export function cancelPricing(): void {
  const { runId } = useResultsStore.getState();
  if (runId) {
    pricerClient.cancel(runId);
  }
}
