import { useState } from 'react';
import { useMarketStore } from '../state/marketStore';
import { fetchSpot } from '../services/spotFetch';
import { fetchHistVol, fetchRefRate, REF_RATE_CCYS } from '../services/marketFetch';
import { NumericField } from './NumericField';
import { TextField } from './TextField';
import { SelectField } from './SelectField';
import { Segmented } from './Segmented';

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

  const assetType = useMarketStore((s) => s.assetType);
  const setAssetType = useMarketStore((s) => s.setAssetType);

  const [fetching, setFetching] = useState(false);
  const [volStatus, setVolStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });
  const [rateStatus, setRateStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  async function handleEstVol() {
    setVolStatus({ kind: 'busy' });
    try {
      const res = await fetchHistVol(underlyingName);
      useMarketStore.setState((s) => ({ market: { ...s.market, vol: res.vol } }));
      setVolStatus({ kind: 'ok', msg: `${(res.vol * 100).toFixed(2)}% · ${res.source} (realized, not implied)` });
    } catch (err) {
      setVolStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Vol estimate unavailable' });
    }
  }

  async function handleFetchRate() {
    setRateStatus({ kind: 'busy' });
    try {
      const res = await fetchRefRate(market.currency);
      useMarketStore.setState((s) => ({ market: { ...s.market, rate: res.rate } }));
      setRateStatus({ kind: 'ok', msg: `${(res.rate * 100).toFixed(3)}% · ${res.source} · ${res.asOf}` });
    } catch (err) {
      setRateStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Rate unavailable' });
    }
  }

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
            <span>Asset type</span>
          </div>
          <Segmented
            value={assetType}
            options={[
              { value: 'share', label: 'Share' },
              { value: 'index', label: 'Index' },
            ]}
            onChange={setAssetType}
          />
        </div>

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
        <button className="btn btn-sm" type="button" disabled={volStatus.kind === 'busy'} onClick={handleEstVol}>
          {volStatus.kind === 'busy' ? 'Estimating…' : 'Est. vol (1Y hist)'}
        </button>
        {volStatus.kind === 'ok' && <div className="status-line ok">{volStatus.msg}</div>}
        {volStatus.kind === 'err' && <div className="status-line error">{volStatus.msg}</div>}

        <NumericField
          label="Rate"
          value={Number((market.rate * 100).toFixed(4))}
          step={0.1}
          suffix="%"
          onChange={(v) => setMarket({ rate: v / 100 })}
        />
        {(REF_RATE_CCYS as readonly string[]).includes(market.currency) && (
          <button className="btn btn-sm" type="button" disabled={rateStatus.kind === 'busy'} onClick={handleFetchRate}>
            {rateStatus.kind === 'busy'
              ? 'Fetching…'
              : `Fetch ${market.currency === 'EUR' ? '€STR' : 'SOFR'}`}
          </button>
        )}
        {rateStatus.kind === 'ok' && <div className="status-line ok">{rateStatus.msg}</div>}
        {rateStatus.kind === 'err' && <div className="status-line error">{rateStatus.msg}</div>}
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
