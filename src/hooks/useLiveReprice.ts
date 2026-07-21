import { useEffect, useMemo, useRef } from 'react';
import type { MarketData } from '../model/market';
import type { ProductSpec } from '../model/product';
import type { SolveTarget } from '../model/request';
import { applySolveValue } from '../worker/pricing';
import { runPricing } from '../services/runPricing';
import { useResultsStore } from '../state/resultsStore';
import type { PageId } from '../state/tradeStore';

/** Trailing-edge debounce before a fast, reduced-path PREVIEW pass fires.
 * Short enough to feel live while the user is mid-edit. */
const PREVIEW_DEBOUNCE_MS = 120;

/** Trailing-edge debounce before the authoritative FULL-precision pass
 * fires, i.e. how long the user has to stop editing before the value
 * settles. Long enough that a burst of keystrokes/spinner clicks collapses
 * into one full run rather than one per keystroke. */
const SETTLE_DEBOUNCE_MS = 300;

export interface UseLiveRepriceParams {
  page: PageId;
  product: ProductSpec;
  market: MarketData;
  underlyingName: string;
  solve: SolveTarget;
  /** Suppress live repricing entirely, e.g. while the form has validation
   * errors — mirrors the explicit Price/Solve button's disabled state. */
  disabled?: boolean;
}

/**
 * Keeps the results panel live — no Price button — for ANY parameter edit,
 * branching on whether a SOLVE target is active:
 *
 * - No solve target (solve.kind === 'none'): a live PRICE. The full product
 *   + market is watched (there's no write-back target to exclude), so
 *   editing any field reprices.
 * - Solve target active: a live SOLVE, watching the full product + market
 *   EXCEPT the solve target's own field — that field is the solver's
 *   output, constant-folded to 0 via applySolveValue(..., 0), so writing the
 *   solved value back into it (writeBackSolvedValue in runPricing) can never
 *   itself retrigger a solve.
 * - `solve` itself is part of the signature either way, so switching which
 *   field is the active solve target (or turning solve off) also reprices.
 *
 * Either way:
 * - A short debounce fires a PREVIEW pass (reduced path count) so the user
 *   sees *something* move almost immediately.
 * - A longer trailing-edge debounce fires the FULL-precision pass once edits
 *   stop — this is the authoritative, settled value.
 * - Each pass hands off to runPricing, which cancels whatever run is still
 *   in flight first (via the worker cancel protocol) so superseded runs
 *   never race the latest one or leak a stale result — UNLESS what's in
 *   flight is an explicit Price/Solve button press, which a live pass must
 *   never preempt (see runPricing/resultsStore: the explicit press is what
 *   the user asked for and what gets recorded to history, so it has to win
 *   even if it's still computing when a live debounce fires — the
 *   issuerCallable/LSMC branch's long synchronous pass makes this easy to
 *   hit in practice).
 * - Solve passes are warm-started from the last known solved value, so they
 *   land in a couple of solver iterations instead of cold-starting.
 * - Both passes skip greeks (expensive, not needed for live feedback) and
 *   are marked `live` so a live-only "no solution" failure shows a calm
 *   inline hint instead of the explicit-failure red error state.
 */
export function useLiveReprice({ page, product, market, underlyingName, solve, disabled }: UseLiveRepriceParams): void {
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the very first fire after mount — activating live-reprice shouldn't
  // itself force a run before the user has done anything; only edits after
  // that (including flipping a SOLVE chip on/off) should.
  const mounted = useRef(false);

  // Signature of everything the current pass depends on. When a solve
  // target is active, the target's own field is EXCLUDED (constant-folded to
  // 0 via applySolveValue) — that field is the solver's output, so its value
  // changing (e.g. from a live-solve write-back) must never itself be
  // treated as an "edit". With no solve target there's no write-back at all,
  // so the full product is watched.
  const signature = useMemo(() => {
    if (disabled) return null;
    if (solve.kind === 'none') {
      return JSON.stringify({ mode: 'price', product, market, solve });
    }
    const watched = applySolveValue(product, solve, 0);
    return JSON.stringify({ mode: 'solve', watched, market, solve });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product, market, solve, disabled]);

  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    previewTimer.current = null;
    settleTimer.current = null;

    if (signature === null) return;
    if (!mounted.current) {
      mounted.current = true;
      return;
    }

    previewTimer.current = setTimeout(() => {
      const warmStartValue = useResultsStore.getState().result?.solvedValue;
      void runPricing({
        page,
        product,
        market,
        underlyingName,
        solve,
        greeks: false,
        preview: true,
        warmStartValue,
        addToHistory: false,
        live: true,
      });
    }, PREVIEW_DEBOUNCE_MS);

    settleTimer.current = setTimeout(() => {
      const warmStartValue = useResultsStore.getState().result?.solvedValue;
      void runPricing({
        page,
        product,
        market,
        underlyingName,
        solve,
        greeks: false,
        preview: false,
        warmStartValue,
        addToHistory: false,
        live: true,
      });
    }, SETTLE_DEBOUNCE_MS);

    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
    // Re-run whenever the watched signature changes; product/market/solve/
    // page/underlyingName are all captured fresh in the closures above via
    // the outer scope, so they don't need to be listed too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
