import { useState } from 'react';
import {
  useMarketStore,
  MAX_EXTRA_LEGS,
  type BasketLegState,
  type CorrelationSource,
} from '../state/marketStore';
import { populateBasketCorrelation } from './basketFetch';
import { buildBasket } from '../model/basket';
import { NumericField } from './NumericField';
import { TickerSearch } from './TickerSearch';
import type { SymbolMatch } from '../services/symbolSearch';

interface Props {
  onClose: () => void;
  /** See BasketPanel's doc: leg 1's ticker pick has to run through
   * MarketPanel's own handler, which also sets the note currency and
   * starts the live fetch. */
  onPickPrimary: (m: SymbolMatch) => void;
}

/** One tile's worth of leg data, whichever leg it is. Leg 0 (the primary
 * underlying) reads and writes the store's top-level ticker/underlyingName/
 * market fields; legs 1+ read and write `extraLegs`. Unifying them behind
 * one shape is what lets every tile use the same JSX. */
interface LegView {
  ticker: string;
  name: string;
  vol: number;
  divYield: number;
  spot?: number;
  currency?: string;
  /** Leg 0 (the primary underlying) is always effectively "fetched": its
   * vol/dividend come from the market panel's own live-fetch flow, not the
   * inherited-on-add path a new extra leg starts from. Marking it fetched
   * keeps the "inherited" marker limited to legs that actually need it. */
  fetched: boolean;
  removable: boolean;
}

/**
 * The worst-of basket editor. A worst-of has no primary underlying: every
 * leg is economically equal, and the price depends on the worst of them.
 * This modal shows one panel per leg, side by side, so the numbers a
 * worst-of actually depends on (spot, vol, dividend) sit in full, un-
 * truncated view — the opposite of the 3-column sidebar grid this replaced,
 * which crushed every one of those numbers into a ~75px column.
 *
 * Follows the same overlay/close/header pattern as HistoryModal and
 * LabModal: same CSS classes, same click-outside-to-close behaviour.
 */
export function BasketModal({ onClose, onPickPrimary }: Props) {
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const ticker = useMarketStore((s) => s.ticker);
  const underlyingCurrency = useMarketStore((s) => s.underlyingCurrency);
  const extraLegs = useMarketStore((s) => s.extraLegs);
  const basketCorrelation = useMarketStore((s) => s.basketCorrelation);
  const basketCorrelationSource = useMarketStore((s) => s.basketCorrelationSource);
  const addLeg = useMarketStore((s) => s.addLeg);
  const removeLeg = useMarketStore((s) => s.removeLeg);
  const setLeg = useMarketStore((s) => s.setLeg);
  const setMarket = useMarketStore((s) => s.setMarket);
  const setBasketCorrelation = useMarketStore((s) => s.setBasketCorrelation);

  const [fetchingCorr, setFetchingCorr] = useState(false);
  const [corrMsg, setCorrMsg] = useState<string | null>(null);
  const [corrOpen, setCorrOpen] = useState(false);
  const [pendingAdd, setPendingAdd] = useState<SymbolMatch | null>(null);

  const nLegs = 1 + extraLegs.length;

  function legAt(i: number): LegView {
    if (i === 0) {
      return {
        ticker,
        name: underlyingName,
        vol: market.vol,
        divYield: market.divYield,
        spot: market.spot,
        currency: underlyingCurrency,
        fetched: true,
        removable: false,
      };
    }
    const leg = extraLegs[i - 1];
    return {
      ticker: leg.ticker,
      name: leg.name,
      vol: leg.vol,
      divYield: leg.divYield,
      spot: leg.spot,
      currency: leg.currency,
      fetched: leg.fetched ?? false,
      removable: true,
    };
  }

  function patchLeg(i: number, patch: Partial<BasketLegState>): void {
    if (i === 0) {
      const marketPatch: Partial<typeof market> = {};
      if (patch.vol !== undefined) marketPatch.vol = patch.vol;
      if (patch.divYield !== undefined) marketPatch.divYield = patch.divYield;
      if (patch.spot !== undefined) marketPatch.spot = patch.spot;
      if (Object.keys(marketPatch).length > 0) setMarket(marketPatch);
      return;
    }
    setLeg(i - 1, patch);
  }

  const built = buildBasket(
    Array.from({ length: nLegs }, (_, i) => {
      const l = legAt(i);
      return { name: l.name, vol: l.vol, divYield: l.divYield };
    }),
    basketCorrelation,
  );

  function cellValue(i: number, j: number): number {
    return basketCorrelation[i]?.[j] ?? (i === j ? 1 : 0);
  }

  function setCell(i: number, j: number, v: number): void {
    const clamped = Math.min(1, Math.max(-1, v));
    const next = basketCorrelation.map((row) => [...row]);
    next[i][j] = clamped;
    next[j][i] = clamped;
    setBasketCorrelation(next, 'manual');
  }

  async function refreshFromHistory(): Promise<void> {
    setFetchingCorr(true);
    setCorrMsg(null);
    const lines = await populateBasketCorrelation(() => true);
    const bad = lines.find((l) => l.kind !== 'ok');
    setCorrMsg(lines.length > 0 ? (bad ?? lines[0]).msg : 'Nothing to populate yet: every leg needs a ticker.');
    setFetchingCorr(false);
  }

  function addPendingLeg(): void {
    if (!pendingAdd || extraLegs.length >= MAX_EXTRA_LEGS) return;
    addLeg();
    // `addLeg` appended at index `extraLegs.length` (before this update), so
    // that is where the picked ticker lands.
    setLeg(extraLegs.length, { ticker: pendingAdd.symbol, name: pendingAdd.name, currency: pendingAdd.currency });
    setPendingAdd(null);
  }

  const pairs: { i: number; j: number }[] = [];
  for (let i = 0; i < nLegs; i++) for (let j = i + 1; j < nLegs; j++) pairs.push({ i, j });
  const avgCorr = pairs.length > 0 ? pairs.reduce((s, p) => s + cellValue(p.i, p.j), 0) / pairs.length : 0;
  const sourceLabel: Record<CorrelationSource, string> = {
    history: 'from 1y realized history',
    default: 'default, not yet measured',
    manual: 'manually entered',
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal basket-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Basket legs ({nLegs})</h2>
          <button className="btn btn-sm" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body basket-modal-body">
          <div className="basket-tile-grid">
            {Array.from({ length: nLegs }, (_, i) => {
              const leg = legAt(i);
              // A leg's currency is set once a live fetch (or a ticker pick
              // that reported one) has run for it. Comparing against the
              // note currency here, not just at the primary leg via
              // market.quanto, is what catches a mismatched EXTRA leg —
              // see validateBasket in services/validation.ts.
              const currencyMismatch = !!leg.currency && leg.currency !== market.currency;
              return (
                <div key={i} className={`basket-tile ${currencyMismatch ? 'basket-tile-error' : ''}`}>
                  <div className="basket-tile-header">
                    <span className="basket-tile-index">Leg {i + 1}</span>
                    <span className="basket-tile-ccy">{leg.currency ?? 'currency unknown'}</span>
                  </div>
                  <TickerSearch
                    label="Name"
                    ticker={leg.ticker}
                    displayName={leg.name || `Leg ${i + 1}`}
                    onPick={(m) => (i === 0 ? onPickPrimary(m) : setLeg(i - 1, { ticker: m.symbol, name: m.name, currency: m.currency }))}
                  />

                  {leg.spot === undefined ? (
                    <div className="field">
                      <div className="field-label">
                        <span>Spot</span>
                      </div>
                      <div className="basket-not-fetched" title="A live fetch has not run for this leg yet.">
                        — not fetched
                      </div>
                    </div>
                  ) : (
                    <NumericField label="Spot" value={leg.spot} step={0.01} onChange={(v) => patchLeg(i, { spot: v })} />
                  )}

                  <div className={leg.fetched ? undefined : 'basket-field-inherited'}>
                    <NumericField
                      label="Vol"
                      value={Number((leg.vol * 100).toFixed(4))}
                      step={0.5}
                      suffix="%"
                      badge={leg.fetched ? undefined : 'inherited'}
                      badgeClassName="inherited-badge"
                      title={leg.fetched ? undefined : "Inherited from leg 1's volatility, not measured for this leg. A live fetch has not run for it yet."}
                      onChange={(v) => patchLeg(i, { vol: v / 100 })}
                    />
                  </div>

                  <div className={leg.fetched ? undefined : 'basket-field-inherited'}>
                    <NumericField
                      label="Div yield"
                      value={Number((leg.divYield * 100).toFixed(4))}
                      step={0.1}
                      suffix="%"
                      badge={leg.fetched ? undefined : 'inherited'}
                      badgeClassName="inherited-badge"
                      title={leg.fetched ? undefined : "Inherited from leg 1's dividend yield, not measured for this leg. A live fetch has not run for it yet."}
                      onChange={(v) => patchLeg(i, { divYield: v / 100 })}
                    />
                  </div>

                  {currencyMismatch && (
                    <div className="status-line error">
                      {leg.currency} vs note {market.currency}. Fetch live to measure this leg's FX
                      volatility and equity-FX correlation, or type them: a foreign leg prices as a
                      quanto leg and cannot price without them.
                    </div>
                  )}

                  <div className="basket-tile-footer">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!leg.removable}
                      onClick={() => leg.removable && removeLeg(i - 1)}
                      title={leg.removable ? `Remove leg ${i + 1}` : 'Leg 1 is the primary underlying and cannot be removed.'}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add a leg by searching for it directly, rather than adding a
           * blank tile and then searching inside it. The "+" stays visible
           * but greyed out when nothing is picked yet or the basket is
           * already full, so the control is discoverable even when it
           * cannot be used right now. */}
          <div className="field-row basket-add-row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <TickerSearch
                label="Add worst-of leg"
                ticker={pendingAdd?.symbol ?? ''}
                displayName={pendingAdd ? pendingAdd.name : ''}
                onPick={(m) => setPendingAdd(m)}
              />
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!pendingAdd || extraLegs.length >= MAX_EXTRA_LEGS}
              onClick={addPendingLeg}
              title={
                extraLegs.length >= MAX_EXTRA_LEGS
                  ? `A worst-of holds at most ${1 + MAX_EXTRA_LEGS} legs`
                  : 'Add this name as the next worst-of leg'
              }
            >
              + Add leg
            </button>
          </div>

          <div className="field-group basket-corr-section">
            <div className="field-label">
              <span>Correlation</span>
              <button type="button" className="btn btn-sm" onClick={() => setCorrOpen((o) => !o)}>
                {corrOpen ? 'Hide' : 'Edit'}
              </button>
            </div>
            <div className="status-line">
              Avg {avgCorr.toFixed(2)} · {sourceLabel[basketCorrelationSource]}
            </div>
            {corrOpen && (
              <div className="field-group">
                {pairs.map((p) => (
                  <div className="field-row corr-row" key={`${p.i}-${p.j}`}>
                    <span className="corr-pair-label">
                      Leg {p.i + 1} × Leg {p.j + 1}
                    </span>
                    <input
                      className="input corr-input"
                      type="number"
                      step={0.05}
                      min={-1}
                      max={1}
                      value={cellValue(p.i, p.j)}
                      onChange={(e) => {
                        if (!Number.isFinite(e.target.valueAsNumber)) return;
                        setCell(p.i, p.j, e.target.valueAsNumber);
                      }}
                    />
                  </div>
                ))}
                <button type="button" className="btn btn-sm" disabled={fetchingCorr} onClick={() => void refreshFromHistory()}>
                  {fetchingCorr ? 'Fetching…' : 'Refresh from history'}
                </button>
                {corrMsg && <div className="status-line">{corrMsg}</div>}
                {built.correlationAdjusted && (
                  <div className="status-line warn">
                    Correlations were adjusted to be mutually consistent (the typed matrix had no valid joint
                    distribution).
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
