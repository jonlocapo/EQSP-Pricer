import { create } from 'zustand';
import { DEFAULT_MARKET, SUPPORTED_CURRENCIES, type MarketData, type QuantoParams } from '../model/market';

export interface FetchStatus {
  state: 'idle' | 'loading' | 'ok' | 'error';
  source?: string;
  asOf?: string;
  message?: string;
}

export type AssetType = 'share' | 'index';

interface MarketState {
  market: MarketData;
  /** Display name, e.g. "The Boeing Company". */
  underlyingName: string;
  /** Yahoo-style symbol driving all data fetches, e.g. "BA", "^SPX". */
  ticker: string;
  assetType: AssetType;
  fetchStatus: FetchStatus;
  manualOverride: boolean;
  /**
   * Currency the underlying actually trades in, per the last successful
   * spot fetch (Yahoo meta). May differ from `market.currency`, the
   * trade's settlement currency. That difference makes it a quanto or
   * composite note. When it differs, MarketPanel shows quanto inputs that
   * populate `market.quanto` — see its warning line.
   */
  underlyingCurrency?: string;
  setMarket: (patch: Partial<MarketData>) => void;
  /**
   * Sets or clears the quanto params without flagging `manualOverride`.
   * That flag tracks manual spot edits, not the quanto or cross-currency
   * mechanics.
   */
  setQuanto: (quanto: QuantoParams | undefined) => void;
  setUnderlyingName: (name: string) => void;
  /** Set from a search pick: symbol, display name, and inferred asset type. */
  /** `currency` is the underlying's listing currency, when the ticker
   * search reported one. It seeds the note currency, so picking a US name
   * switches the note to USD rather than silently leaving a quanto, while
   * remaining manually overridable. It always records underlyingCurrency
   * for quanto detection, even when the note cannot be quoted in it. */
  setUnderlying: (ticker: string, name: string, assetType: AssetType, currency?: string) => void;
  setAssetType: (t: AssetType) => void;
  setFetchStatus: (s: FetchStatus) => void;
  markManualOverride: () => void;
  applyFetchedSpot: (spot: number, source: string, asOf: string, underlyingCurrency?: string) => void;
  restoreMarket: (market: MarketData, underlyingName: string) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  market: { ...DEFAULT_MARKET },
  // EURO STOXX 50 as the default: a EUR index matches the EUR default note
  // currency, so the app opens in a consistent single-currency state rather
  // than an accidental quanto. ^STOXX50E is Yahoo's symbol for it — SX5E-style
  // tickers are not, and produce no price or option history.
  underlyingName: 'EURO STOXX 50',
  ticker: '^STOXX50E',
  assetType: 'index',
  fetchStatus: { state: 'idle' },
  manualOverride: false,
  underlyingCurrency: undefined,
  setMarket: (patch) =>
    set((s) => ({ market: { ...s.market, ...patch }, manualOverride: true })),
  setQuanto: (quanto) => set((s) => ({ market: { ...s.market, quanto } })),
  setUnderlyingName: (name) => set({ underlyingName: name }),
  setUnderlying: (ticker, underlyingName, assetType, currency) =>
    set((s) => ({
      ticker,
      underlyingName,
      assetType,
      fetchStatus: { state: 'idle' },
      underlyingCurrency: currency ?? s.underlyingCurrency,
      market:
        currency && SUPPORTED_CURRENCIES.includes(currency)
          ? { ...s.market, currency }
          : s.market,
    })),
  setAssetType: (assetType) => set({ assetType }),
  setFetchStatus: (fetchStatus) => set({ fetchStatus }),
  markManualOverride: () => set({ manualOverride: true }),
  applyFetchedSpot: (spot, source, asOf, underlyingCurrency) =>
    set((s) => ({
      // The note currency follows the underlying here, not at ticker-pick time:
      // Yahoo's SEARCH endpoint does not report a currency, but the chart
      // endpoint behind the spot fetch does. Relying on the search response was
      // why picking a US name never switched the note to USD. Only adopt
      // currencies the app can actually quote; a manual change afterwards still
      // wins, since this only runs on a fetch.
      market:
        underlyingCurrency && SUPPORTED_CURRENCIES.includes(underlyingCurrency)
          ? { ...s.market, spot, currency: underlyingCurrency }
          : { ...s.market, spot },
      fetchStatus: { state: 'ok', source, asOf },
      manualOverride: false,
      underlyingCurrency,
    })),
  restoreMarket: (market, underlyingName) =>
    set({ market, underlyingName, manualOverride: false, fetchStatus: { state: 'idle' }, underlyingCurrency: undefined }),
}));
