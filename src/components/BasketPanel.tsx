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
  /** Picking a ticker for leg 1 (the primary underlying) has to run through
   * MarketPanel's own `handlePrimaryPick`: it also sets the note currency
   * and kicks off the live fetch, neither of which this panel owns. Legs 2
   * and up use the store's own `setLeg` directly, no callback needed. */
  onPickPrimary: (m: SymbolMatch) => void;
}

/** One row's worth of leg data, whichever leg it is. Leg 0 (the primary
 * underlying) reads and writes the store's top-level ticker/underlyingName/
 * market fields; legs 1+ read and write `extraLegs`. Unifying them behind
 * one shape is what lets the metric grid below treat every column exactly
 * the same way. */
interface LegView {
  ticker: string;
  name: string;
  vol: number;
  divYield: number;
  spot?: number;
  removable: boolean;
}

/** A worst-of has no primary underlying: every leg is economically equal,
 * and the price depends on the worst of them. This panel shows every leg
 * side by side, one column per leg, one row per metric (spot, volatility,
 * dividend), so the numbers a worst-of actually depends on sit next to each
 * other for comparison instead of being buried in per-leg blocks.
 *
 * Renders nothing beyond the "add a leg" search when there is only one leg,
 * so a plain single-underlying trade stays visually simple.
 */
export function BasketPanel({ onPickPrimary }: Props) {
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const ticker = useMarketStore((s) => s.ticker);
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
      return { ticker, name: underlyingName, vol: market.vol, divYield: market.divYield, spot: market.spot, removable: false };
    }
    const leg = extraLegs[i - 1];
    return { ticker: leg.ticker, name: leg.name, vol: leg.vol, divYield: leg.divYield, spot: leg.spot, removable: true };
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

  const cols = nLegs === 3 ? 3 : 2; // 2 legs -> 2x1, 3 legs -> 3x1, 4 legs -> 2x2 (grid auto-wraps).
  const gridClass = `metric-grid cols-${cols}`;

  const pairs: { i: number; j: number }[] = [];
  for (let i = 0; i < nLegs; i++) for (let j = i + 1; j < nLegs; j++) pairs.push({ i, j });
  const avgCorr = pairs.length > 0 ? pairs.reduce((s, p) => s + cellValue(p.i, p.j), 0) / pairs.length : 0;
  const sourceLabel: Record<CorrelationSource, string> = {
    history: 'from 1y realized history',
    default: 'default, not yet measured',
    manual: 'manually entered',
  };

  return (
    <div className="field-group">
      {nLegs >= 2 && (
        <>
          <div className="field-label">
            <span>Basket legs ({nLegs})</span>
          </div>
          <div className={gridClass}>
            {Array.from({ length: nLegs }, (_, i) => (
              <div className="field-label" key={i}>
                <span>Leg {i + 1} of {nLegs}</span>
              </div>
            ))}
          </div>
          <div className={gridClass}>
            {Array.from({ length: nLegs }, (_, i) => {
              const leg = legAt(i);
              return (
                <TickerSearch
                  key={i}
                  ticker={leg.ticker}
                  displayName={leg.name || `Leg ${i + 1}`}
                  onPick={(m) => (i === 0 ? onPickPrimary(m) : setLeg(i - 1, { ticker: m.symbol, name: m.name, currency: m.currency }))}
                />
              );
            })}
          </div>
          <div className={gridClass}>
            {Array.from({ length: nLegs }, (_, i) =>
              legAt(i).removable ? (
                <button key={i} type="button" className="btn btn-sm" onClick={() => removeLeg(i - 1)} title={`Remove leg ${i + 1}`}>
                  Remove
                </button>
              ) : (
                <span key={i} />
              ),
            )}
          </div>
          <div className={gridClass}>
            {Array.from({ length: nLegs }, (_, i) => (
              <NumericField
                key={i}
                label={`Spot ${i + 1}`}
                value={legAt(i).spot ?? 0}
                step={0.01}
                onChange={(v) => patchLeg(i, { spot: v })}
              />
            ))}
          </div>
          <div className={gridClass}>
            {Array.from({ length: nLegs }, (_, i) => (
              <NumericField
                key={i}
                label={`Vol ${i + 1}`}
                value={Number((legAt(i).vol * 100).toFixed(4))}
                step={0.5}
                suffix="%"
                onChange={(v) => patchLeg(i, { vol: v / 100 })}
              />
            ))}
          </div>
          <div className={gridClass}>
            {Array.from({ length: nLegs }, (_, i) => (
              <NumericField
                key={i}
                label={`Div ${i + 1}`}
                value={Number((legAt(i).divYield * 100).toFixed(4))}
                step={0.1}
                suffix="%"
                onChange={(v) => patchLeg(i, { divYield: v / 100 })}
              />
            ))}
          </div>
        </>
      )}

      {/* Add a leg by searching for it directly, rather than adding a blank
       * row and then searching inside it. The "+" stays visible but greyed
       * out when nothing is picked yet or the basket is already full, so
       * the control is discoverable even when it cannot be used right now. */}
      <div className="field-row" style={{ alignItems: 'flex-end' }}>
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

      {nLegs >= 2 && (
        <div className="field-group">
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
      )}
    </div>
  );
}
