import { useEffect, useMemo, useRef } from 'react';
import type { MarketData } from '../model/market';
import type { ProductSpec } from '../model/product';
import type { SolveTarget } from '../model/request';
import { applySolveValue } from '../worker/pricing';
import { runPricing, peekRepriceScope } from '../services/runPricing';
import { peekEditSource } from '../state/editSource';
import { useResultsStore } from '../state/resultsStore';
import type { PageId } from '../state/tradeStore';

/**
 * Debounce profiles, chosen by how the edit was made (see state/editSource).
 *
 * 'step' (our stepper buttons): every tick is a complete, intended value. So
 * feedback can come almost immediately. The wait only needs to collapse a
 * burst of rapid clicks into one run. A reduced-path preview lands fast,
 * then the full-precision pass settles it.
 *
 * 'type': keystrokes pass through values the user never meant. For example,
 * clearing the "8" of "80" to type "70" transiently reads 0, and each
 * intermediate state would otherwise burn a full solve. So typing waits
 * noticeably longer and skips the preview entirely. One solve is
 * sufficient, which is the whole point of waiting.
 */
const DEBOUNCE: Record<'type' | 'step', { preview: number | null; settle: number }> = {
  step: { preview: 90, settle: 260 },
  type: { preview: null, settle: 600 },
};

export interface UseLiveRepriceParams {
  page: PageId;
  product: ProductSpec;
  market: MarketData;
  underlyingName: string;
  solve: SolveTarget;
  /** Suppress live repricing entirely, for example while the form has
   * validation errors. Mirrors the explicit Price/Solve button's disabled
   * state. */
  disabled?: boolean;
}

/**
 * Keeps the results panel live, with no Price button, for ANY parameter
 * edit. It branches on whether a SOLVE target is active:
 *
 * - No solve target (solve.kind === 'none'): a live PRICE. The hook watches
 *   the full product and market, since there is no write-back target to
 *   exclude. So editing any field reprices.
 * - Solve target active: a live SOLVE, watching the full product and market
 *   EXCEPT the solve target's own field. That field is the solver's output,
 *   constant-folded to 0 via applySolveValue(..., 0). So writing the solved
 *   value back into it (writeBackSolvedValue in runPricing) can never
 *   itself retrigger a solve.
 * - `solve` itself is part of the signature either way. So switching which
 *   field is the active solve target, or turning solve off, also reprices.
 *
 * Either way:
 * - The wait before firing depends on HOW the edit was made (see DEBOUNCE
 *   and state/editSource). Stepper clicks get a short wait plus a
 *   reduced-path PREVIEW pass, so arrow bursts feel immediate. Typing waits
 *   longer and skips the preview, so the meaningless intermediate values a
 *   keystroke sequence passes through do not each burn a solve.
 * - A trailing-edge debounce fires the FULL-precision pass once edits stop.
 *   This is the authoritative, settled value.
 * - Each pass hands off to runPricing, which cancels whatever run is still
 *   in flight first, via the worker cancel protocol. So superseded runs
 *   never race the latest one or leak a stale result — UNLESS what is in
 *   flight is an explicit Price/Solve button press, which a live pass must
 *   never preempt. See runPricing/resultsStore: the explicit press is what
 *   the user asked for and what gets recorded to history. So it has to win,
 *   even if it is still computing when a live debounce fires. The
 *   issuerCallable/LSMC branch's long synchronous pass makes this easy to
 *   hit in practice.
 * - Solve passes are warm-started from the last known solved value, so they
 *   land in a couple of solver iterations instead of cold-starting.
 * - Both passes skip greeks, which are expensive and not needed for live
 *   feedback, and are marked `live`, so a live-only "no solution" failure
 *   shows a calm inline hint instead of the explicit-failure red error
 *   state.
 */
export function useLiveReprice({ page, product, market, underlyingName, solve, disabled }: UseLiveRepriceParams): void {
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the very first fire after mount. Activating live-reprice should not
  // itself force a run before the user has done anything. Only edits after
  // that, including flipping a SOLVE chip on or off, should.
  const mounted = useRef(false);

  // Signature of everything the current pass depends on. When a solve target
  // is active, the target's own field is EXCLUDED, constant-folded to 0 via
  // applySolveValue. That field is the solver's output. So its value
  // changing, for example from a live-solve write-back, must never itself be
  // treated as an "edit". With no solve target, there is no write-back at
  // all. So the hook watches the full product.
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

    // Show loading feedback the instant this edit is detected, before either
    // debounce elapses. This keeps the previous value from sitting frozen
    // while waiting for a pass to actually start.
    useResultsStore.getState().beginPending(peekRepriceScope(market, product));

    const timing = DEBOUNCE[peekEditSource()];

    if (timing.preview !== null) {
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
      }, timing.preview);
    }

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
    }, timing.settle);

    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
    // Re-run whenever the watched signature changes. product, market, solve,
    // page, and underlyingName are all captured fresh in the closures above
    // via the outer scope. So they do not need to be listed too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
