import { create } from 'zustand';
import { DEFAULT_MARKET, type MarketData } from '../model/market';

export interface FetchStatus {
  state: 'idle' | 'loading' | 'ok' | 'error';
  source?: string;
  asOf?: string;
  message?: string;
}

export type AssetType = 'share' | 'index';

interface MarketState {
  market: MarketData;
  underlyingName: string;
  assetType: AssetType;
  fetchStatus: FetchStatus;
  manualOverride: boolean;
  setMarket: (patch: Partial<MarketData>) => void;
  setUnderlyingName: (name: string) => void;
  setAssetType: (t: AssetType) => void;
  setFetchStatus: (s: FetchStatus) => void;
  markManualOverride: () => void;
  applyFetchedSpot: (spot: number, source: string, asOf: string) => void;
  restoreMarket: (market: MarketData, underlyingName: string) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  market: { ...DEFAULT_MARKET },
  underlyingName: 'SPX Index',
  assetType: 'index',
  fetchStatus: { state: 'idle' },
  manualOverride: false,
  setMarket: (patch) =>
    set((s) => ({ market: { ...s.market, ...patch }, manualOverride: true })),
  setUnderlyingName: (name) => set({ underlyingName: name }),
  setAssetType: (assetType) => set({ assetType }),
  setFetchStatus: (fetchStatus) => set({ fetchStatus }),
  markManualOverride: () => set({ manualOverride: true }),
  applyFetchedSpot: (spot, source, asOf) =>
    set((s) => ({
      market: { ...s.market, spot },
      fetchStatus: { state: 'ok', source, asOf },
      manualOverride: false,
    })),
  restoreMarket: (market, underlyingName) =>
    set({ market, underlyingName, manualOverride: false, fetchStatus: { state: 'idle' } }),
}));
