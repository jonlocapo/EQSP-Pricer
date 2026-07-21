import { useEffect, useMemo, useRef } from 'react';
import type { MarketData } from '../model/market';
import type { ProductSpec } from '../model/product';
import type { SolveTarget } from '../model/request';
import { applySolveValue } from '../worker/pricing';
import { runPricing, cancelPricing } from '../services/runPricing';
import { useResultsStore } from '../state/resultsStore';
import type { PageId } from '../state/tradeStore';

/** Trailing-edge debounce before a fast, reduced-path PREVIEW solve fires.
 * Short enough to feel live while the user is mid-edit. */
const PREVIEW_DEBOUNCE_MS = 120;

/** Trailing-edge debounce before the authoritative FULL-precision solve
 * fires, i.e. how long the user has to stop editing before the value
 * settles. Long enough that a burst of keystrokes/spinner clicks collapses
 * into one full solve rather than one per keystroke. */
const SETTLE_DEBOUNCE_MS = 300;

export interface UseLiveSolveParams {
  page: PageId;
  product: ProductSpec;
  market: MarketData;
  underlyingName: string;
  solve: SolveTarget;
  greeks: boolean;
  /** Suppress live solving entirely, e.g. while the form has validation
   * errors — mirrors the explicit Price/Solve button's disabled state. */
  disabled?: boolean;
}

/**
 * Watches the active solve target's product/market inputs and keeps the
 * solved value updating live, without a button press:
 *
 * - Any edit to a field OTHER than the active solve target's own field
 *   (that field is the solver's output, not an input — excluded from the
 *   watched signature via applySolveValue(..., 0), so writing the solved
 *   value back into it can never itself retrigger a solve) reschedules two
 *   debounced passes.
 * - A short debounce fires a PREVIEW solve (reduced path count) so the user
 *   sees *something* move almost immediately.
 * - A longer trailing-edge debounce fires the FULL-precision solve once
 *   edits stop — this is the authoritative, settled value.
 * - Each pass cancels whatever solve is still in flight first (via the
 *   existing worker cancel protocol) so superseded runs never race the
 *   latest one or leak a stale result.
 * - Both passes are warm-started from the last known solved value, so they
 *   land in a couple of solver iterations instead of cold-starting.
 */
export function useLiveSolve({
  page,
  product,
  market,
  underlyingName,
  solve,
  greeks,
  disabled,
}: UseLiveSolveParams): void {
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the very first fire after mount — activating live-solve shouldn't
  // itself force a run before the user has done anything; only edits after
  // that (including flipping a SOLVE chip on) should.
  const mounted = useRef(false);

  // Signature of everything the current solve depends on, EXCLUDING the
  // solve target's own field (constant-folded to 0 via applySolveValue) —
  // that field is the solver's output, so its value changing (e.g. from a
  // live-solve write-back) must never itself be treated as an "edit".
  const signature = useMemo(() => {
    if (solve.kind === 'none' || disabled) return null;
    const watched = applySolveValue(product, solve, 0);
    return JSON.stringify({ watched, market, solve });
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
      cancelPricing();
      const warmStartValue = useResultsStore.getState().result?.solvedValue;
      void runPricing({
        page,
        product,
        market,
        underlyingName,
        solve,
        greeks,
        preview: true,
        warmStartValue,
        addToHistory: false,
      });
    }, PREVIEW_DEBOUNCE_MS);

    settleTimer.current = setTimeout(() => {
      cancelPricing();
      const warmStartValue = useResultsStore.getState().result?.solvedValue;
      void runPricing({
        page,
        product,
        market,
        underlyingName,
        solve,
        greeks,
        preview: false,
        warmStartValue,
        addToHistory: false,
      });
    }, SETTLE_DEBOUNCE_MS);

    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
    // Re-run whenever the watched signature changes; product/market/solve/
    // page/underlyingName/greeks are all captured fresh in the closures
    // above via the outer scope, so they don't need to be listed too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
