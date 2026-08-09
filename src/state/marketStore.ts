import { create } from 'zustand';
import { DEFAULT_MARKET, SUPPORTED_CURRENCIES, type MarketData, type QuantoParams } from '../model/market';
import { resizeCorrelation, removeFromCorrelation } from '../model/basket';

/** One additional worst-of leg beyond the primary underlying (index 0),
 * which stays the existing ticker/underlyingName/market.vol/divYield. Kept
 * deliberately spot-free: every payoff here reads relative performance
 * S(t)/S(0), so a leg's starting level cancels and is never read. */
export interface BasketLegState {
  ticker: string;
  name: string;
  vol: number;
  divYield: number;
  currency?: string;
}

/** Realistic worst-of range: 2 to 4 total legs, so at most 3 extra ones. */
export const MAX_EXTRA_LEGS = 3;

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
  /** Legs 2..4 of a worst-of basket. Empty means a single underlying. */
  extraLegs: BasketLegState[];
  /** Correlation matrix exactly as typed, dimension (1 + extraLegs.length),
   * leg 0 first. May not be PSD; repaired on its way into MarketData (see
   * model/basket.ts's buildBasket). */
  basketCorrelation: number[][];
  addLeg: () => void;
  removeLeg: (i: number) => void;
  setLeg: (i: number, patch: Partial<BasketLegState>) => void;
  setBasketCorrelation: (matrix: number[][]) => void;
  setMarket: (patch: Partial<MarketData>) => void;
  /**
   * Sets or clears the quanto params without flagging `manualOverride`.
   * That flag tracks manual spot edits, not the quanto or cross-currency
   * mechanics.
   */
  setQuanto: (quanto: QuantoParams | undefined) => void;
  /** Sets or clears MarketData.basket without flagging `manualOverride`,
   * for the same reason as setQuanto: this tracks the leg editor
   * recomputing derived data, not a manual spot edit. */
  setBasket: (basket: MarketData['basket']) => void;
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
  extraLegs: [],
  basketCorrelation: [[1]],
  addLeg: () =>
    set((s) => {
      if (s.extraLegs.length >= MAX_EXTRA_LEGS) return s;
      const extraLegs = [
        ...s.extraLegs,
        { ticker: '', name: '', vol: s.market.vol, divYield: s.market.divYield },
      ];
      return { extraLegs, basketCorrelation: resizeCorrelation(s.basketCorrelation, 1 + extraLegs.length) };
    }),
  removeLeg: (i) =>
    set((s) => {
      const extraLegs = s.extraLegs.filter((_, idx) => idx !== i);
      // +1: index 0 in basketCorrelation is the primary leg, so extra leg i
      // sits at correlation row/column i + 1.
      return { extraLegs, basketCorrelation: removeFromCorrelation(s.basketCorrelation, i + 1) };
    }),
  setLeg: (i, patch) =>
    set((s) => ({
      extraLegs: s.extraLegs.map((leg, idx) => (idx === i ? { ...leg, ...patch } : leg)),
    })),
  setBasketCorrelation: (basketCorrelation) => set({ basketCorrelation }),
  setMarket: (patch) =>
    set((s) => ({ market: { ...s.market, ...patch }, manualOverride: true })),
  setQuanto: (quanto) => set((s) => ({ market: { ...s.market, quanto } })),
  setBasket: (basket) => set((s) => ({ market: { ...s.market, basket } })),
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
    set({
      market,
      underlyingName,
      manualOverride: false,
      fetchStatus: { state: 'idle' },
      underlyingCurrency: undefined,
      // A history entry's own market.basket, if any, is restored above with
      // `market` itself. The leg-editor state is UI-only scaffolding, not
      // part of the priced request, so it resets rather than mixing a new
      // trade's legs with whatever was being edited before the restore.
      extraLegs: [],
      basketCorrelation: [[1]],
    }),
}));
