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

export const SOLVE_LABELS: Record<SolveTarget['kind'], string> = {
  none: 'Price',
  couponPa: 'Coupon p.a.',
  acCouponPa: 'AC Coupon',
  couponBarrier: 'Coupon Barrier',
  callBarrier: 'Call Barrier',
  kiBarrier: 'KI Barrier',
  putStrike: 'Put Strike',
  gearing: 'Upside participation',
  upsideStrike: 'Upside strike',
  bonusLevel: 'Bonus',
  twinWin: 'Twin-win participation',
  upperStrike: 'Upper Strike',
  upsideKoBarrier: 'KO Barrier',
  rebate: 'Rebate',
  strike: 'Strike',
  koTrigger: 'KO Trigger',
  upfront: 'Upfront',
};

function termsSummaryFor(product: ProductSpec): string {
  if (product.kind === 'coupon') return couponTermsSummary(product);
  if (product.kind === 'participation') return participationTermsSummary(product);
  if (product.kind === 'accumulator') return accumulatorTermsSummary(product);
  // Lab specs never reach runPricing — LabModal prices directly through
  // pricerClient (see LabModal.tsx) and never records to history. This
  // branch only satisfies exhaustiveness.
  return 'lab contract';
}

/**
 * After a successful solve, write the solved value back into the relevant
 * spec field. This lets the UI render it read-only and dimmed, as the "last
 * solved value", per the design spec.
 */
function writeBackSolvedValue(
  product: ProductSpec,
  solve: SolveTarget,
  solvedValue: number | undefined
): void {
  if (solvedValue === undefined) return;
  // Round to 4 decimals for display in the form. The results panel keeps
  // the raw value.
  solvedValue = Math.round(solvedValue * 1e4) / 1e4;
  const trade = useTradeStore.getState();

  // Solving for the price means the REOFFER field is the output: its value is
  // the PV just computed. Without writing it back, the greyed-out Reoffer cell
  // kept showing whatever was typed before, so the displayed target no longer
  // matched the computed price — and worse, the next solve of any other field
  // used that stale reoffer as its target, which is why back-solving appeared
  // not to work at all.
  if (solve.kind === 'none') {
    if (product.kind === 'accumulator') trade.setAccumulatorSpec({ upfrontPct: solvedValue });
    else if (product.kind === 'coupon') trade.setCouponSpec({ reofferPct: solvedValue });
    else trade.patchParticipationSpec({ reofferPct: solvedValue });
    return;
  }

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
      case 'putStrike':
        trade.setCouponSpec({ putStrikePct: solvedValue });
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
    case 'koTrigger':
      trade.setAccumulatorSpec({ koTriggerPct: solvedValue });
      break;
    case 'upfront':
      trade.setAccumulatorSpec({ upfrontPct: solvedValue });
      break;
    default:
      break;
  }
}

interface RunPricingParams {
  page: PageId;
  product: ProductSpec;
  market: MarketData;
  underlyingName: string;
  solve: SolveTarget;
  greeks: boolean;
  /** Fast, transient pass at reduced path count (see PriceRequest.preview).
   * Defaults to false, full precision. */
  preview?: boolean;
  /** Seeds the solver's warm-start bracket with a previously solved value,
   * typically the last committed solvedValue. This lets a live re-solve
   * converge in a couple of iterations, instead of cold-starting. */
  warmStartValue?: number;
  /** Whether this run gets recorded to the trade history log. A live-solve
   * pass — preview and debounced-settle — passes false, so rapid edits do
   * not flood history. Only the explicit Price/Solve button records an
   * entry. Defaults to true. */
  addToHistory?: boolean;
  /** True for a run auto-triggered by useLiveReprice, with no button press.
   * This flag changes only how the code handles a failure. A live pass that
   * fails because the solve bracket has no reachable root is a calm,
   * expected outcome while the user is mid-edit. It sets the soft
   * `liveUnsolvable` state and keeps the last good result, instead of
   * flipping the panel into the alarming red error state reserved for
   * explicit button presses. Any other failure, an unexpected error, still
   * surfaces as a normal error even on a live pass. Defaults to false. */
  live?: boolean;
}

/** Matches the asyncRootFind "bracket doesn't contain a root" message
 * (src/worker/pricing.ts). This is the one failure mode that is an
 * expected, calm outcome during live editing, not a real error. Exported so
 * gridRun.ts can classify a per-cell no-solution failure the same way,
 * instead of duplicating the pattern. */
export const NO_SOLUTION_RE = /no solution .* not reachable/i;

/**
 * The pricing "environment": everything that determines whether the MC
 * engine can reuse its cached raw paths (src/engine/pathCache.ts), rather
 * than generate a fresh set. This deliberately excludes product terms that
 * do not touch path generation (barriers, coupons, strikes, and so on), and
 * excludes numPaths. A preview pass and a full-precision pass always
 * regenerate against each other under the current single-entry cache. That
 * is still "the same environment" from the user's point of view, just a
 * different precision.
 */
function envFingerprint(market: MarketData, product: ProductSpec): string {
  return JSON.stringify({
    spot: market.spot,
    vol: market.vol,
    rate: market.rate,
    rateCurve: market.rateCurve ?? null,
    divYield: market.divYield,
    quanto: market.quanto ?? null,
    // A basket edit changes every path, so it must start a fresh pricing
    // environment rather than reuse the last one.
    basket: market.basket ?? null,
    tenorYears: product.tenorYears,
  });
}

let lastEnvFingerprint: string | null = null;

/**
 * Predicts whether a run for this market and product would reuse the last
 * pricing environment ('cached'), or start a fresh one ('full'), WITHOUT
 * committing it. This lets the UI show loading feedback the instant an edit
 * happens (see useLiveReprice.beginPending), before the debounced pass that
 * actually issues the request commits the real answer.
 */
export function peekRepriceScope(market: MarketData, product: ProductSpec): 'full' | 'cached' {
  const fp = envFingerprint(market, product);
  return lastEnvFingerprint !== null && lastEnvFingerprint === fp ? 'cached' : 'full';
}

/** Test-only: resets the tracked environment fingerprint so tests don't leak
 * scope state into each other via this module-level singleton. */
export function __resetRepriceScopeForTests(): void {
  lastEnvFingerprint = null;
}

/**
 * Same comparison as peekRepriceScope, but for a request actually being
 * issued. Only a FULL-precision pass commits the new fingerprint. A preview
 * pass must not commit it. Otherwise the settle pass for the SAME edit —
 * which does the real, possibly expensive, work — would compare against the
 * preview's own just-committed fingerprint and see no change. That would
 * wrongly report 'cached' for a genuine environment change, for example a
 * spot edit, and show the small spinner instead of the bar for the pass
 * that actually deserves it.
 */
function resolveRepriceScope(market: MarketData, product: ProductSpec, preview: boolean): 'full' | 'cached' {
  const fp = envFingerprint(market, product);
  const scope = lastEnvFingerprint !== null && lastEnvFingerprint === fp ? 'cached' : 'full';
  if (!preview) lastEnvFingerprint = fp;
  return scope;
}

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
  // A background live-reprice pass must never preempt an explicit Price or
  // Solve press that is still in flight. The explicit press is the one the
  // user asked for, and the one that gets recorded to history. So it has to
  // win, regardless of which one's worker response happens to land first.
  // (An explicit press, conversely, always supersedes whatever is running,
  // live or explicit, so it is not gated here at all.) This matters more
  // than it might look. The issuerCallable/LSMC branch prices in one
  // synchronous, non-yielding pass, with no mid-run cancellation. So an
  // in-flight run there routinely outlives a 120-300ms live-reprice
  // debounce. This race is easy to hit in practice, not a theoretical
  // corner case.
  if (live) {
    const current = useResultsStore.getState();
    if (current.running && current.runKind === 'explicit') {
      // This live pass is dropped, not deferred: no later pass is scheduled
      // for the edit that raised `pending`. The explicit run settles with
      // its own authoritative result, so clear the pending flag here rather
      // than letting the spinner stick once that run terminates — none of
      // this edit's own passes will ever start to clear it (see
      // resultsStore's terminal transitions).
      useResultsStore.setState({ pending: false, pendingScope: null });
      return;
    }
  }

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

  // Any other run still in flight at this point — a previous live pass, or,
  // for an explicit press, even a previous explicit one — is superseded by
  // this one. Cancel it before this run claims `runId`, so its own
  // eventual, possibly late, settlement can never be mistaken for this
  // run's. See finishRun/failRun/cancelRun's id guard in resultsStore for
  // the belt-and-braces half of this fix.
  cancelPricing();

  const scope = resolveRepriceScope(market, product, preview);
  const results = useResultsStore.getState();
  results.startRun(id, live ? 'live' : 'explicit', scope);

  try {
    const result = await pricerClient.price(req, (p) => {
      useResultsStore.getState().setProgress(p);
    });
    useResultsStore.getState().finishRun(id, result);
    // With no solve target the PV *is* the solved value for the reoffer field.
    writeBackSolvedValue(product, solve, result.solvedValue ?? result.pvPct);

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
      // Cancelled. A newer run superseded this one; not a failure at all.
      useResultsStore.getState().cancelRun(id);
    } else if (live && NO_SOLUTION_RE.test(message)) {
      // Expected, calm outcome while editing live into an unreachable
      // bracket. Keep the last good result on screen, just flag it stale.
      useResultsStore.getState().failLiveRun(id, 'No solution at current terms.');
    } else {
      // Explicit failure (button press), or an unexpected error even on a
      // live pass. This is the normal, clearly flagged error state.
      useResultsStore.getState().failRun(id, message);
    }
  }
}

export function cancelPricing(): void {
  const { runId } = useResultsStore.getState();
  if (runId) {
    pricerClient.cancel(runId);
  }
}
