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
  running: boolean;
  progress: ProgressState | null;
  result: PriceResult | null;
  error: string | null;
  /** Soft, non-alarming warning set when a LIVE (auto-triggered) pass fails
   * because the solve target has no reachable root at the current terms —
   * distinct from `error`, which is reserved for explicit Price/Solve button
   * failures. The last good `result` is deliberately left untouched so the
   * UI can keep showing it (dimmed/stale) rather than flipping to the red
   * error state. Cleared automatically the moment a later run succeeds. */
  liveUnsolvable: string | null;
  expanded: boolean;
  startRun: (id: string) => void;
  setProgress: (p: ProgressState) => void;
  finishRun: (result: PriceResult) => void;
  failRun: (message: string) => void;
  /** Soft counterpart to failRun for live (button-less) passes: keeps
   * `result`/`error` untouched, only sets the calm `liveUnsolvable` hint. */
  failLiveRun: (message: string) => void;
  cancelRun: () => void;
  toggleExpanded: () => void;
  setExpanded: (v: boolean) => void;
}

export const useResultsStore = create<ResultsState>((set) => ({
  runId: null,
  running: false,
  progress: null,
  result: null,
  error: null,
  liveUnsolvable: null,
  expanded: false,
  startRun: (id) => set({ runId: id, running: true, progress: null, error: null, expanded: false }),
  setProgress: (progress) => set({ progress }),
  finishRun: (result) => set({ running: false, result, progress: null, liveUnsolvable: null }),
  failRun: (message) => set({ running: false, error: message, progress: null, liveUnsolvable: null }),
  failLiveRun: (message) => set({ running: false, progress: null, liveUnsolvable: message }),
  cancelRun: () => set({ running: false, progress: null }),
  toggleExpanded: () => set((s) => ({ expanded: !s.expanded })),
  setExpanded: (expanded) => set({ expanded }),
}));
