import { useEffect, useState } from 'react';
import { useTradeStore, rebuildCustomCallSchedule } from '../state/tradeStore';
import { useMarketStore } from '../state/marketStore';
import { useResultsStore } from '../state/resultsStore';
import { Card } from '../components/Card';
import { Segmented } from '../components/Segmented';
import { NumericField } from '../components/NumericField';
import { TenorField } from '../components/TenorField';
import { Toggle } from '../components/Toggle';
import { ActionRow } from '../components/ActionRow';
import { validateCoupon } from '../services/validation';
import { couponSolveOptions } from '../services/solveOptions';
import { runPricing } from '../services/runPricing';
import type { BarrierMonitoring, CallType, CouponType, Frequency } from '../model/product';
import type { SolveTarget } from '../model/request';

const FREQ_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'semiannual', label: 'Semi-annual' },
  { value: 'annual', label: 'Annual' },
];

export function CouponPage() {
  const spec = useTradeStore((s) => s.couponSpec);
  const solve = useTradeStore((s) => s.couponSolve);
  const setSpec = useTradeStore((s) => s.setCouponSpec);
  const setSolve = useTradeStore((s) => s.setCouponSolve);
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const running = useResultsStore((s) => s.running);

  const [greeks, setGreeks] = useState(false);
  const [lastAcCouponPa, setLastAcCouponPa] = useState(2);

  // Keep custom call schedule sized to the current number of call observations.
  useEffect(() => {
    if (spec.callType !== 'custom') return;
    const rebuilt = rebuildCustomCallSchedule(spec);
    if (
      rebuilt.length !== spec.customCallBarriersPct.length ||
      rebuilt.some((v, i) => v !== spec.customCallBarriersPct[i])
    ) {
      setSpec({ customCallBarriersPct: rebuilt });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.callType, spec.tenorYears, spec.callFrequency]);

  const validation = validateCoupon(spec, market);
  const solveOptions = couponSolveOptions(spec);
  const currentSolveOpt = solveOptions.find((o) => o.value === solve.kind);
  const priceDisabled = !validation.valid || (currentSolveOpt?.disabled ?? false);
  const priceLabel = solve.kind === 'none' ? 'Price' : 'Solve';

  function fieldSolved(kind: SolveTarget['kind']): boolean {
    return solve.kind === kind;
  }

  function handleRun() {
    runPricing({
      page: 'coupon',
      product: spec,
      market,
      underlyingName,
      solve,
      greeks,
    });
  }

  const nCallObs =
    spec.callType === 'none'
      ? 0
      : Math.max(1, Math.round(spec.tenorYears * { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 }[spec.callFrequency]));

  return (
    <div className="page-grid">
      <Card title="General Terms">
        <div className="field-row">
          <NumericField
            label="Notional"
            value={spec.notional}
            step={10000}
            suffix={spec.currency}
            onChange={(v) => setSpec({ notional: v })}
            error={validation.errors.notional}
          />
        </div>
        <TenorField
          years={spec.tenorYears}
          onChange={(v) => setSpec({ tenorYears: v })}
          error={validation.errors.tenorYears}
        />
        <div className="field">
          <div className="field-label">
            <span>Solve for</span>
          </div>
          <select
            className="input"
            value={solve.kind}
            onChange={(e) => setSolve({ kind: e.target.value } as SolveTarget)}
          >
            {solveOptions.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled} title={o.tooltip}>
                {o.label}
                {o.disabled ? ` — ${o.tooltip ?? 'unavailable'}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field-row">
          <NumericField
            label="Reoffer"
            value={spec.reofferPct}
            step={0.1}
            suffix="%"
            onChange={(v) => setSpec({ reofferPct: v })}
            error={validation.errors.reofferPct}
          />
          <NumericField
            label="Issue price"
            value={spec.issuePricePct}
            step={0.1}
            suffix="%"
            onChange={(v) => setSpec({ issuePricePct: v })}
            error={validation.errors.issuePricePct}
          />
        </div>
      </Card>

      <Card title="Downside">
        <div className="field">
          <div className="field-label">
            <span>Barrier type</span>
          </div>
          <Segmented<BarrierMonitoring>
            value={spec.barrierType}
            options={[
              { value: 'none', label: 'None' },
              { value: 'european', label: 'European' },
              { value: 'american', label: 'American' },
            ]}
            onChange={(v) => setSpec({ barrierType: v })}
          />
        </div>
        {spec.barrierType !== 'none' && (
          <NumericField
            label="KI barrier"
            value={spec.kiBarrierPct}
            step={1}
            suffix="%"
            onChange={(v) => setSpec({ kiBarrierPct: v })}
            error={validation.errors.kiBarrierPct}
            solved={fieldSolved('kiBarrier')}
          />
        )}
        <div className="field-row">
          <NumericField
            label="Put strike"
            value={spec.putStrikePct}
            step={1}
            suffix="%"
            onChange={(v) => setSpec({ putStrikePct: v })}
          />
          <NumericField
            label="Downside leverage"
            value={spec.downsideLeveragePct}
            step={5}
            suffix="%"
            onChange={(v) => setSpec({ downsideLeveragePct: v })}
          />
        </div>
      </Card>

      <Card title="Call Feature">
        <div className="field">
          <div className="field-label">
            <span>Call type</span>
          </div>
          <Segmented<CallType>
            value={spec.callType}
            options={[
              { value: 'none', label: 'None' },
              { value: 'constant', label: 'Constant' },
              { value: 'stepdown', label: 'Step-down' },
              { value: 'custom', label: 'Custom' },
              { value: 'issuerCallable', label: 'Issuer Callable' },
            ]}
            onChange={(v) => setSpec({ callType: v })}
          />
        </div>
        {spec.callType !== 'none' && (
          <>
            <div className="field">
              <div className="field-label">
                <span>Frequency</span>
              </div>
              <Segmented<Frequency>
                value={spec.callFrequency}
                options={FREQ_OPTIONS}
                onChange={(v) => setSpec({ callFrequency: v })}
              />
            </div>
            <div className="field-row">
              <NumericField
                label="Callable from period"
                value={spec.callFromPeriod}
                step={1}
                min={1}
                max={nCallObs}
                onChange={(v) => setSpec({ callFromPeriod: v })}
                error={validation.errors.callFromPeriod}
              />
            </div>
            {(spec.callType === 'constant' || spec.callType === 'stepdown') && (
              <div className="field-row">
                <NumericField
                  label="Call barrier"
                  value={spec.callBarrierPct}
                  step={1}
                  suffix="%"
                  onChange={(v) => setSpec({ callBarrierPct: v })}
                  solved={fieldSolved('callBarrier')}
                />
                {spec.callType === 'stepdown' && (
                  <NumericField
                    label="Step-down / period"
                    value={spec.stepDownPct}
                    step={0.5}
                    suffix="%"
                    onChange={(v) => setSpec({ stepDownPct: v })}
                  />
                )}
              </div>
            )}
            {spec.callType === 'custom' && (
              <div className="field">
                <div className="field-label">
                  <span>Custom call schedule</span>
                </div>
                <div className="schedule-scroll">
                  <table className="schedule-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>~Date offset</th>
                        <th>Barrier %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spec.customCallBarriersPct.map((v, i) => {
                        const periodYears = ((i + 1) * spec.tenorYears) / spec.customCallBarriersPct.length;
                        return (
                          <tr key={i}>
                            <td>{i + 1}</td>
                            <td>{periodYears.toFixed(2)}y</td>
                            <td>
                              <input
                                className={`input ${validation.rowErrors?.[i] ? 'invalid' : ''}`}
                                type="number"
                                step={1}
                                value={v}
                                onChange={(e) => {
                                  const next = [...spec.customCallBarriersPct];
                                  next[i] = e.target.valueAsNumber;
                                  setSpec({ customCallBarriersPct: next });
                                }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Periodic Coupon">
        <div className="field">
          <div className="field-label">
            <span>Coupon type</span>
          </div>
          <Segmented<CouponType>
            value={spec.couponType}
            options={[
              { value: 'fixed', label: 'Fixed' },
              { value: 'conditional', label: 'Conditional' },
              { value: 'memory', label: 'Memory' },
            ]}
            onChange={(v) => setSpec({ couponType: v })}
          />
        </div>
        <div className="field">
          <div className="field-label">
            <span>Frequency</span>
          </div>
          <Segmented<Frequency>
            value={spec.couponFrequency}
            options={FREQ_OPTIONS}
            onChange={(v) => setSpec({ couponFrequency: v })}
          />
        </div>
        {spec.couponType !== 'fixed' && (
          <NumericField
            label="Coupon barrier"
            value={spec.couponBarrierPct}
            step={1}
            suffix="%"
            onChange={(v) => setSpec({ couponBarrierPct: v })}
            solved={fieldSolved('couponBarrier')}
          />
        )}
        <NumericField
          label="Coupon p.a."
          value={spec.couponPaPct}
          step={0.1}
          suffix="%"
          onChange={(v) => setSpec({ couponPaPct: v })}
          solved={fieldSolved('couponPa')}
        />
      </Card>

      {spec.callType !== 'none' && (
        <Card title="Autocall Coupon">
          <Toggle
            label="AC coupon"
            checked={spec.autocallCouponPaPct > 0}
            onChange={(on) => {
              if (on) {
                setSpec({ autocallCouponPaPct: lastAcCouponPa || 2 });
              } else {
                setLastAcCouponPa(spec.autocallCouponPaPct || 2);
                setSpec({ autocallCouponPaPct: 0 });
              }
            }}
          />
          {spec.autocallCouponPaPct > 0 && (
            <NumericField
              label="AC coupon p.a."
              value={spec.autocallCouponPaPct}
              step={0.1}
              suffix="%"
              onChange={(v) => setSpec({ autocallCouponPaPct: v })}
              solved={fieldSolved('acCouponPa')}
            />
          )}
        </Card>
      )}

      <div style={{ gridColumn: '1 / -1' }}>
        <ActionRow
          label={priceLabel}
          disabled={priceDisabled}
          tooltip={currentSolveOpt?.tooltip ?? 'Fix validation errors above.'}
          onRun={handleRun}
          greeks={greeks}
          onGreeksChange={setGreeks}
          running={running}
        />
      </div>
    </div>
  );
}
