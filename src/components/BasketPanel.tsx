import { useState } from 'react';
import { useMarketStore, MAX_EXTRA_LEGS } from '../state/marketStore';
import { realizedCorrelationMatrix } from '../services/marketFetch';
import { buildBasket } from '../model/basket';
import { NumericField } from './NumericField';
import { TickerSearch } from './TickerSearch';

/**
 * Worst-of basket editor: add up to 3 extra legs beyond the primary
 * underlying above, set each leg's vol and dividend yield, and edit the
 * correlation matrix between them. Renders nothing beyond the "Add leg"
 * button when there is only one leg, so a plain single-underlying trade
 * looks exactly as it did before this panel existed.
 */
export function BasketPanel() {
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const ticker = useMarketStore((s) => s.ticker);
  const extraLegs = useMarketStore((s) => s.extraLegs);
  const basketCorrelation = useMarketStore((s) => s.basketCorrelation);
  const addLeg = useMarketStore((s) => s.addLeg);
  const removeLeg = useMarketStore((s) => s.removeLeg);
  const setLeg = useMarketStore((s) => s.setLeg);
  const setBasketCorrelation = useMarketStore((s) => s.setBasketCorrelation);

  const [fetchingCorr, setFetchingCorr] = useState(false);
  const [corrMsg, setCorrMsg] = useState<string | null>(null);

  const nLegs = 1 + extraLegs.length;

  const built = buildBasket(
    [{ name: underlyingName, vol: market.vol, divYield: market.divYield }, ...extraLegs],
    basketCorrelation
  );

  function cellValue(i: number, j: number): number {
    return basketCorrelation[i]?.[j] ?? (i === j ? 1 : 0);
  }

  function setCell(i: number, j: number, v: number): void {
    const clamped = Math.min(1, Math.max(-1, v));
    const next = basketCorrelation.map((row) => [...row]);
    next[i][j] = clamped;
    next[j][i] = clamped;
    setBasketCorrelation(next);
  }

  async function populateFromHistory(): Promise<void> {
    const tickers = [ticker, ...extraLegs.map((l) => l.ticker)];
    if (tickers.some((t) => !t.trim())) {
      setCorrMsg('Every leg needs a ticker before history can be fetched.');
      return;
    }
    setFetchingCorr(true);
    setCorrMsg(null);
    try {
      const { matrix, errors } = await realizedCorrelationMatrix(tickers);
      setBasketCorrelation(matrix);
      setCorrMsg(errors.length > 0 ? `Some pairs failed: ${errors.join('; ')}` : 'Populated from 1y realized correlation.');
    } catch (e) {
      setCorrMsg(e instanceof Error ? e.message : 'Realized correlation fetch failed.');
    } finally {
      setFetchingCorr(false);
    }
  }

  return (
    <div className="field-group">
      <div className="field-label">
        <span>Basket legs</span>
      </div>
      {extraLegs.map((leg, i) => (
        <div className="field-group" key={i} style={{ borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
          <div className="field-row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <TickerSearch
                ticker={leg.ticker}
                displayName={leg.name || `Leg ${i + 2}`}
                onPick={(m) => setLeg(i, { ticker: m.symbol, name: m.name, currency: m.currency })}
              />
            </div>
            <button
              type="button"
              className="btn btn-sm"
              title="Remove this leg"
              onClick={() => removeLeg(i)}
            >
              Remove
            </button>
          </div>
          <div className="field-row">
            <NumericField
              label="Volatility"
              value={Number((leg.vol * 100).toFixed(4))}
              step={0.5}
              suffix="%"
              onChange={(v) => setLeg(i, { vol: v / 100 })}
            />
            <NumericField
              label="Dividend yield"
              value={Number((leg.divYield * 100).toFixed(4))}
              step={0.1}
              suffix="%"
              onChange={(v) => setLeg(i, { divYield: v / 100 })}
            />
          </div>
        </div>
      ))}

      <button
        type="button"
        className="btn btn-sm"
        disabled={extraLegs.length >= MAX_EXTRA_LEGS}
        onClick={addLeg}
        title="Add a worst-of leg (up to 4 legs total)"
      >
        + Add leg
      </button>

      {nLegs >= 2 && (
        <div className="field-group">
          <div className="field-label">
            <span>Correlation matrix</span>
          </div>
          <div className="schedule-scroll">
            <table className="schedule-table">
              <thead>
                <tr>
                  <th></th>
                  {Array.from({ length: nLegs }, (_, j) => (
                    <th key={j}>{j === 0 ? underlyingName || 'Leg 1' : extraLegs[j - 1]?.name || `Leg ${j + 1}`}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: nLegs }, (_, i) => (
                  <tr key={i}>
                    <td>{i === 0 ? underlyingName || 'Leg 1' : extraLegs[i - 1]?.name || `Leg ${i + 1}`}</td>
                    {Array.from({ length: nLegs }, (_, j) => (
                      <td key={j}>
                        {i === j ? (
                          <span>1.00</span>
                        ) : (
                          <input
                            className="input"
                            type="number"
                            step={0.05}
                            min={-1}
                            max={1}
                            value={cellValue(i, j)}
                            onChange={(e) => {
                              if (!Number.isFinite(e.target.valueAsNumber)) return;
                              setCell(i, j, e.target.valueAsNumber);
                            }}
                          />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={fetchingCorr}
            onClick={() => void populateFromHistory()}
            title="Fetch 1y daily closes for every leg and fill the matrix with realized correlation"
          >
            {fetchingCorr ? 'Fetching…' : 'Populate from history'}
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
  );
}
