import { useState } from 'react';
import { useMarketStore } from '../state/marketStore';
import { fetchSpot } from '../services/spotFetch';
import { NumericField } from './NumericField';
import { TextField } from './TextField';
import { SelectField } from './SelectField';

const CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP', 'JPY'];

function formatAsOf(asOf?: string): string {
  if (!asOf) return '';
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return asOf;
  return d.toLocaleString();
}

export function MarketPanel() {
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const fetchStatus = useMarketStore((s) => s.fetchStatus);
  const manualOverride = useMarketStore((s) => s.manualOverride);
  const setMarket = useMarketStore((s) => s.setMarket);
  const setUnderlyingName = useMarketStore((s) => s.setUnderlyingName);
  const setFetchStatus = useMarketStore((s) => s.setFetchStatus);
  const applyFetchedSpot = useMarketStore((s) => s.applyFetchedSpot);

  const [fetching, setFetching] = useState(false);

  async function handleFetch() {
    setFetching(true);
    setFetchStatus({ state: 'loading' });
    try {
      const res = await fetchSpot(underlyingName || market.currency);
      applyFetchedSpot(res.spot, res.source, res.asOf);
    } catch (err) {
      setFetchStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'Fetch unavailable — enter spot manually',
      });
    } finally {
      setFetching(false);
    }
  }

  return (
    <div>
      <h3 className="sidebar-title">Market Data</h3>
      <div className="field-group">
        <SelectField
          label="Currency"
          value={market.currency}
          options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          onChange={(v) => setMarket({ currency: v })}
        />
        <TextField label="Underlying" value={underlyingName} onChange={setUnderlyingName} />

        <div className="field">
          <div className="field-label">
            <span>Spot</span>
            {manualOverride && <span className="manual-badge">MANUAL</span>}
          </div>
          <div className="numeric-field">
            <input
              className="input"
              type="number"
              step={0.01}
              value={market.spot}
              onChange={(e) => setMarket({ spot: e.target.valueAsNumber })}
            />
          </div>
        </div>

        <button className="btn btn-sm" type="button" disabled={fetching} onClick={handleFetch}>
          {fetching ? 'Fetching…' : 'Fetch spot'}
        </button>
        {fetchStatus.state === 'ok' && (
          <div className="status-line ok">
            {fetchStatus.source} · {formatAsOf(fetchStatus.asOf)}
          </div>
        )}
        {fetchStatus.state === 'error' && (
          <div className="status-line error">{fetchStatus.message}</div>
        )}

        <NumericField
          label="Volatility"
          value={Number((market.vol * 100).toFixed(4))}
          step={0.5}
          suffix="%"
          onChange={(v) => setMarket({ vol: v / 100 })}
        />
        <NumericField
          label="Rate"
          value={Number((market.rate * 100).toFixed(4))}
          step={0.1}
          suffix="%"
          onChange={(v) => setMarket({ rate: v / 100 })}
        />
        <NumericField
          label="Dividend yield"
          value={Number((market.divYield * 100).toFixed(4))}
          step={0.1}
          suffix="%"
          onChange={(v) => setMarket({ divYield: v / 100 })}
        />
      </div>
    </div>
  );
}
