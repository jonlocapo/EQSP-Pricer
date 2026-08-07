import { create } from 'zustand';
import type { PriceResult } from '../model/request';
import type { PricingPhase } from '../worker/protocol';

interface ProgressState {
  pathsDone: number;
  pathsTotal: number;
  phase: PricingPhase;
  solveIteration?: number;
}

interface ResultsState {
  runId: string | null;
  /** Whether the currently in-flight or most-recent run was an explicit
   * Price/Solve button press, or an auto-triggered live-reprice pass. Used
   * only to decide whether a *new* live pass is allowed to preempt what is
   * running (see runPricing). A live pass must never cancel an explicit
   * press that is still in flight. The explicit press is the one the user
   * asked for, and the one that gets recorded to history. So it has to
   * win, regardless of which one's worker response happens to land first. */
  runKind: 'live' | 'explicit' | null;
  /** Whether the current or most recent run reused the cached MC paths
   * ('cached' — only product terms changed, the underlying, market, and
   * tenor stayed put), or had to generate a fresh Monte Carlo ('full' —
   * the pricing environment itself changed). Drives which loading chrome
   * ResultsBar shows: a small spinner next to the last value for 'cached',
   * the full bottom progress bar for 'full'. See runPricing's
   * commitRepriceScope. */
  runScope: 'full' | 'cached' | null;
  running: boolean;
  /** True from the instant an edit is detected until the debounced pass it
   * triggers actually starts. This lets the UI show loading feedback
   * immediately, instead of leaving the previous value looking frozen
   * during the 120-300ms debounce window — see useLiveReprice.beginPending. */
  pending: boolean;
  /** Best-guess scope for the pending edit, computed the same way as
   * runScope but before the debounced pass has actually started. */
  pendingScope: 'full' | 'cached' | null;
  progress: ProgressState | null;
  result: PriceResult | null;
  error: string | null;
  /** Soft, non-alarming warning set when a LIVE, auto-triggered, pass fails
   * because the solve target has no reachable root at the current terms.
   * Distinct from `error`, which is reserved for explicit Price/Solve
   * button failures. The last good `result` is deliberately left
   * untouched, so the UI can keep showing it, dimmed and stale, instead of
   * flipping to the red error state. Cleared automatically the moment a
   * later run succeeds. */
  liveUnsolvable: string | null;
  expanded: boolean;
  /** Marks an edit as queued for repricing, immediately, before either
   * debounce elapses. Cleared the moment the pass it anticipates actually
   * starts (startRun), and on every terminal transition (finish/fail/cancel,
   * see below), so a dropped pass can never leave the spinner stuck.
   *
   * The id guard on the terminal transitions is what keeps them safe for a
   * NEWER pending edit: a superseded run settling late is a no-op entirely,
   * and a current run's transition only clears pending when no newer edit
   * has raised it again since — in which case the newer edit's own pass
   * re-raises it within the debounce window. A brief spinner blink is
   * preferable to a stuck one. */
  beginPending: (scope: 'full' | 'cached') => void;
  startRun: (id: string, kind: 'live' | 'explicit', scope: 'full' | 'cached') => void;
  setProgress: (p: ProgressState) => void;
  /** All four terminal transitions below take the `id` of the run they
   * belong to, and are no-ops if it no longer matches the store's `runId`.
   * Runs race the shared worker and store — a live-reprice debounce and an
   * explicit Price/Solve press can both be in flight, see useLiveReprice
   * and runPricing — and cancellation of a superseded run is not always
   * timely. The issuerCallable/LSMC branch runs a whole pass synchronously,
   * with no mid-run cancellation check. So its "cancelled" message can
   * arrive well after a newer run has already become current. Without this
   * guard, a slow, already-superseded run's late result, error, or
   * cancellation would clobber whatever the newer run already produced.
   *
   * Every terminal transition also clears `pending`. Without it, an edit
   * whose pass was dropped — a live pass gated by an in-flight explicit
   * run, see runPricing — would leave `pending` true forever, because no
   * run of its own ever starts to clear it. The spinner would stay stuck
   * after the run that superseded it finished. See beginPending's comment
   * for why this does not clobber a newer edit's pending state. */
  finishRun: (id: string, result: PriceResult) => void;
  failRun: (id: string, message: string) => void;
  /** Soft counterpart to failRun for live, button-less, passes. Keeps
   * `result` and `error` untouched, and only sets the calm `liveUnsolvable`
   * hint. */
  failLiveRun: (id: string, message: string) => void;
  cancelRun: (id: string) => void;
  toggleExpanded: () => void;
  setExpanded: (v: boolean) => void;
}

export const useResultsStore = create<ResultsState>((set) => ({
  runId: null,
  runKind: null,
  runScope: null,
  running: false,
  pending: false,
  pendingScope: null,
  progress: null,
  result: null,
  error: null,
  liveUnsolvable: null,
  expanded: false,
  beginPending: (scope) => set({ pending: true, pendingScope: scope }),
  startRun: (id, kind, scope) =>
    set({
      runId: id,
      runKind: kind,
      runScope: scope,
      running: true,
      pending: false,
      pendingScope: null,
      progress: null,
      error: null,
      expanded: false,
    }),
  setProgress: (progress) => set({ progress }),
  finishRun: (id, result) =>
    set((s) =>
      s.runId === id
        ? { running: false, result, progress: null, pending: false, pendingScope: null, liveUnsolvable: null }
        : {},
    ),
  failRun: (id, message) =>
    set((s) =>
      s.runId === id
        ? { running: false, error: message, progress: null, pending: false, pendingScope: null, liveUnsolvable: null }
        : {},
    ),
  failLiveRun: (id, message) =>
    set((s) =>
      s.runId === id
        ? { running: false, progress: null, pending: false, pendingScope: null, liveUnsolvable: message }
        : {},
    ),
  cancelRun: (id) =>
    set((s) =>
      s.runId === id ? { running: false, progress: null, pending: false, pendingScope: null } : {},
    ),
  toggleExpanded: () => set((s) => ({ expanded: !s.expanded })),
  setExpanded: (expanded) => set({ expanded }),
}));
