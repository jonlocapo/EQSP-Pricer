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
  expanded: boolean;
  startRun: (id: string) => void;
  setProgress: (p: ProgressState) => void;
  finishRun: (result: PriceResult) => void;
  failRun: (message: string) => void;
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
  expanded: false,
  startRun: (id) => set({ runId: id, running: true, progress: null, error: null }),
  setProgress: (progress) => set({ progress }),
  finishRun: (result) => set({ running: false, result, progress: null }),
  failRun: (message) => set({ running: false, error: message, progress: null }),
  cancelRun: () => set({ running: false, progress: null }),
  toggleExpanded: () => set((s) => ({ expanded: !s.expanded })),
  setExpanded: (expanded) => set({ expanded }),
}));
