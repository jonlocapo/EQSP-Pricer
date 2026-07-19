import { useEffect, useRef, useState } from 'react';
import { useTradeStore, rebuildCustomCallSchedule } from '../state/tradeStore';
import { useMarketStore } from '../state/marketStore';
import { useResultsStore } from '../state/resultsStore';
import { Card } from '../components/Card';
import { Segmented } from '../components/Segmented';
import { NumericField } from '../components/NumericField';
import { TenorField } from '../components/TenorField';
import { ActionRow } from '../components/ActionRow';
import { validateCoupon } from '../services/validation';
import { couponSolveOptions } from '../services/solveOptions';
import { runPricing } from '../services/runPricing';
import type { AcCouponType, BarrierMonitoring, CallType, CouponType, Frequency } from '../model/product';
import type { SolveTarget } from '../model/request';

/** Standard downside leverage: 1/putStrike so a 100% stock decline redeems to 0. */
function autoDownsideLeverage(putStrikePct: number): number {
  if (!(putStrikePct > 0)) return 100;
  return Math.round((10000 / putStrikePct) * 100) / 100;
}

const AUTO_LEVERAGE_EPS = 0.01;

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

  // Downside leverage auto-tracks 1/putStrike (the industry-standard geared
  // put) until the user types a value that diverges from it. Detected by:
  // when putStrike changes, if the leverage still equals the auto value for
  // the OLD strike, carry the tracking forward to the new strike's auto
  // value; otherwise leave the user's override alone.
  const prevPutStrikeRef = useRef(spec.putStrikePct);
  useEffect(() => {
    const prevStrike = prevPutStrikeRef.current;
    if (prevStrike !== spec.putStrikePct) {
      const autoForOld = autoDownsideLeverage(prevStrike);
      if (Math.abs(spec.downsideLeveragePct - autoForOld) < AUTO_LEVERAGE_EPS) {
        setSpec({ downsideLeveragePct: autoDownsideLeverage(spec.putStrikePct) });
      }
      prevPutStrikeRef.current = spec.putStrikePct;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.putStrikePct]);

  const validation = validateCoupon(spec, market);
  const solveOptions = couponSolveOptions(spec);
  const currentSolveOpt = solveOptions.find((o) => o.value === solve.kind);
  const priceDisabled = !validation.valid || (currentSolveOpt?.disabled ?? false);
  const priceLabel = solve.kind === 'none' ? 'Price' : 'Solve';

  function fieldSolved(kind: SolveTarget['kind']): boolean {
    return solve.kind === kind;
  }

  // "Price (reoffer)" is solve kind 'none' — its output is the price shown in
  // the results panel, not a spec field. The Reoffer field is the closest
  // analogue of that output (the target price the solve engine matches), so
  // dim it the same way the other solve targets dim their own field.
  const priceIsSolveTarget = solve.kind === 'none';

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
            solved={priceIsSolveTarget}
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
            badge={
              Math.abs(spec.downsideLeveragePct - autoDownsideLeverage(spec.putStrikePct)) < AUTO_LEVERAGE_EPS
                ? 'AUTO'
                : undefined
            }
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
              { value: 'issuerCallable', label: 'Issuer' },
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
                label="Non-call periods"
                value={spec.callFromPeriod - 1}
                step={1}
                min={0}
                max={Math.max(0, nCallObs - 1)}
                onChange={(v) => setSpec({ callFromPeriod: v + 1 })}
                error={validation.errors.callFromPeriod}
                hint={`first call: period ${spec.callFromPeriod}`}
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
          <div className="field">
            <div className="field-label">
              <span>AC coupon type</span>
            </div>
            <Segmented<AcCouponType>
              value={spec.acCouponType}
              options={[
                { value: 'none', label: 'None' },
                { value: 'flat', label: 'Flat' },
                { value: 'snowball', label: 'Snowball' },
              ]}
              onChange={(v) =>
                setSpec({ acCouponType: v, acCouponPct: v === 'none' ? spec.acCouponPct : spec.acCouponPct || 2 })
              }
            />
          </div>
          {spec.acCouponType !== 'none' && (
            <NumericField
              label={spec.acCouponType === 'flat' ? 'AC Coupon (%)' : 'AC Coupon p.a. (%)'}
              value={spec.acCouponPct}
              step={0.1}
              suffix="%"
              onChange={(v) => setSpec({ acCouponPct: v })}
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
