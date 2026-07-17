import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MarketData } from '../model/market';
import type { ProductSpec } from '../model/product';
import type { SolveTarget } from '../model/request';
import type { PageId } from './tradeStore';

const MAX_ENTRIES = 200;

export interface HistoryEntry {
  id: string;
  timestamp: number;
  page: PageId;
  termsSummary: string;
  marketSummary: string;
  pvPct: number;
  solvedValue?: number;
  solveLabel?: string;
  product: ProductSpec;
  market: MarketData;
  underlyingName: string;
  solve: SolveTarget;
}

interface HistoryState {
  entries: HistoryEntry[];
  addEntry: (e: HistoryEntry) => void;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      entries: [],
      addEntry: (e) =>
        set((s) => ({ entries: [e, ...s.entries].slice(0, MAX_ENTRIES) })),
      clear: () => set({ entries: [] }),
    }),
    { name: 'eqsp-pricer-history' }
  )
);
