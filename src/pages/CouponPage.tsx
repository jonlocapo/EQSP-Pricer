import { useEffect, useState } from 'react';
import { useTradeStore, rebuildCustomCallSchedule } from '../state/tradeStore';
import { useMarketStore } from '../state/marketStore';
import { useResultsStore } from '../state/resultsStore';
import { Card } from '../components/Card';
import { Segmented } from '../components/Segmented';
import { NumericField } from '../components/NumericField';
import { nextStepValue } from '../components/numericStep';
import { TenorField } from '../components/TenorField';
import { PricingFooter } from '../components/PricingFooter';
import { noteEditSource } from '../state/editSource';
import { validateCoupon, validateBasket } from '../services/validation';
import { runPricing } from '../services/runPricing';
import { useLiveReprice } from '../hooks/useLiveReprice';
import { AUTO_LEVERAGE_EPS, autoDownsideLeverage, makeFieldSolved, makeToggleSolve, priceLabelFor, usePricingSpec } from './pageHelpers';
import type { AcCouponType, BarrierMonitoring, CallType, CouponType, Frequency } from '../model/product';
import { coerceFrequency, isFrequencyAllowed, MONTHS_PER_PERIOD } from '../model/product';

const FREQ_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'semiannual', label: 'Semi-annual' },
  { value: 'annual', label: 'Annual' },
];

/** FREQ_OPTIONS with the periods this tenor cannot carry greyed out. A note's
 * tenor is always a multiple of its frequency, so an 18-month note simply has
 * no annual option. See `isFrequencyAllowed` for what went wrong when the
 * combination was reachable. */
function freqOptionsFor(tenorYears: number) {
  return FREQ_OPTIONS.map((o) =>
    isFrequencyAllowed(tenorYears, o.value)
      ? o
      : {
          ...o,
          disabled: true,
          tooltip: `A ${MONTHS_PER_PERIOD[o.value]}-month period does not divide this tenor.`,
        },
  );
}

export function CouponPage() {
  const spec = useTradeStore((s) => s.couponSpec);
  const solve = useTradeStore((s) => s.couponSolve);
  const setSpec = useTradeStore((s) => s.setCouponSpec);
  const setSolve = useTradeStore((s) => s.setCouponSolve);
  const market = useMarketStore((s) => s.market);
  const basketCorrelation = useMarketStore((s) => s.basketCorrelation);
  const running = useResultsStore((s) => s.running);

  const { underlyingName, legsForValidation, pricingSpec } = usePricingSpec(spec);

  const [greeks, setGreeks] = useState(false);
  const [leverageAuto, setLeverageAuto] = useState(true);
  // Coupon and call (AC) observations almost always share a schedule, and a
  // mismatch is usually a mistake rather than an intent. AUTO keeps the coupon
  // frequency locked to the call frequency; turning it off allows a deliberate
  // mismatch.
  const [couponFreqAuto, setCouponFreqAuto] = useState(true);

  /** Writes one cell of the custom call barrier schedule, tagging the edit so
   * it gets the debounce its source deserves. */
  function setBarrierAt(index: number, value: number, source: 'type' | 'step'): void {
    noteEditSource(source);
    const next = [...spec.customCallBarriersPct];
    next[index] = value;
    setSpec({ customCallBarriersPct: next });
  }

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

  // A tenor edit can strand a frequency that was legal a moment ago: 2 years
  // annual becomes 18 months annual, and the second annual date would fall
  // after maturity. Snap both schedules to the closest period the new tenor
  // allows. This runs BEFORE the AUTO effect below, so a coupon frequency
  // following the call frequency picks up the corrected value.
  useEffect(() => {
    const call = coerceFrequency(spec.tenorYears, spec.callFrequency);
    const coupon = coerceFrequency(spec.tenorYears, spec.couponFrequency);
    if (call !== spec.callFrequency || coupon !== spec.couponFrequency) {
      setSpec({ callFrequency: call, couponFrequency: coupon });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.tenorYears, spec.callFrequency, spec.couponFrequency]);

  // When AUTO is on, downside leverage is locked to 1/putStrike, the
  // industry-standard geared put, and recomputed whenever the put strike
  // changes or AUTO is toggled on. Guarded so it only writes when the value
  // actually differs, to avoid redundant re-renders.
  useEffect(() => {
    if (!leverageAuto) return;
    const auto = autoDownsideLeverage(spec.putStrikePct);
    if (Math.abs(spec.downsideLeveragePct - auto) >= AUTO_LEVERAGE_EPS) {
      setSpec({ downsideLeveragePct: auto });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leverageAuto, spec.putStrikePct]);

  // Keep the coupon frequency following the call frequency while AUTO is on.
  useEffect(() => {
    if (!couponFreqAuto) return;
    if (spec.callType === 'none') return; // no call schedule to follow
    if (spec.couponFrequency !== spec.callFrequency) {
      setSpec({ couponFrequency: spec.callFrequency });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [couponFreqAuto, spec.callFrequency, spec.callType, spec.couponFrequency]);

  const validation = validateCoupon(spec, market);
  const basketValidation = validateBasket(legsForValidation, basketCorrelation, market);

  // Per-field solve availability, mirroring the old solveOptions.ts helper.
  // Under issuerCallable (LSMC pricing; v1 supports Price only), nothing
  // else is solvable.
  const issuerCallable = spec.callType === 'issuerCallable';
  const canCouponPa = !issuerCallable;
  const canAcCoupon = !issuerCallable && spec.acCouponType !== 'none';
  const canCouponBarrier = !issuerCallable && spec.couponType !== 'fixed';
  const canCallBarrier = !issuerCallable && (spec.callType === 'constant' || spec.callType === 'stepdown');
  const canKiBarrier = !issuerCallable && spec.barrierType !== 'none';
  const canPutStrike = !issuerCallable;

  // Whenever a spec change makes the current solve target unavailable, fall
  // back to Price ('none'), so no stale solve target reaches the worker.
  useEffect(() => {
    const kind = solve.kind;
    if (kind === 'none') return;
    const available =
      (kind === 'couponPa' && canCouponPa) ||
      (kind === 'acCouponPa' && canAcCoupon) ||
      (kind === 'couponBarrier' && canCouponBarrier) ||
      (kind === 'callBarrier' && canCallBarrier) ||
      (kind === 'kiBarrier' && canKiBarrier) ||
      (kind === 'putStrike' && canPutStrike);
    if (!available) setSolve({ kind: 'none' });
  }, [solve.kind, canCouponPa, canAcCoupon, canCouponBarrier, canCallBarrier, canKiBarrier, canPutStrike, setSolve]);

  const priceDisabled = !validation.valid || !basketValidation.valid;
  const priceLabel = priceLabelFor(solve);

  useLiveReprice({
    page: 'coupon',
    product: pricingSpec,
    market,
    underlyingName,
    solve,
    disabled: priceDisabled,
  });

  const fieldSolved = makeFieldSolved(solve);
  const toggleSolve = makeToggleSolve(solve, setSolve);

  // "Price (reoffer)" is solve kind 'none'. Its output is the price shown in
  // the results panel, not a spec field. The Reoffer field is the closest
  // analogue of that output, the target price the solve engine matches. So
  // dim it the same way the other solve targets dim their own field.
  const priceIsSolveTarget = solve.kind === 'none';

  // Detected, not stored. An airbag is a *combination* of existing fields —
  // put strike at the barrier with matching raw-shortfall leverage. So the
  // hint follows whatever the user has actually set.
  const isAirbag =
    spec.barrierType !== 'none' &&
    spec.kiBarrierPct > 0 &&
    Math.abs(spec.putStrikePct - spec.kiBarrierPct) < 1e-9 &&
    Math.abs(spec.downsideLeveragePct - 10000 / spec.kiBarrierPct) < 1e-6;

  function handleRun() {
    runPricing({
      page: 'coupon',
      product: pricingSpec,
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
            suffix={market.currency}
            onChange={(v) => setSpec({ notional: v })}
            error={validation.errors.notional}
          />
        </div>
        <TenorField
          years={spec.tenorYears}
          onChange={(v) => setSpec({ tenorYears: v })}
          error={validation.errors.tenorYears}
        />
        <div className="field-row">
          <NumericField
            label="Reoffer"
            value={spec.reofferPct}
            step={0.1}
            suffix="%"
            onChange={(v) => setSpec({ reofferPct: v })}
            error={validation.errors.reofferPct}
            solved={priceIsSolveTarget}
            solveChip
            solveActive={priceIsSolveTarget}
            onSolveClick={() => setSolve({ kind: 'none' })}
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
            solveChip={canKiBarrier}
            solveActive={fieldSolved('kiBarrier')}
            onSolveClick={() => toggleSolve('kiBarrier')}
          />
        )}
        {spec.barrierType !== 'none' && (
          <div className="field">
            <div className="field-label">
              <span>Downside style</span>
            </div>
            {/* One-shot actions, not sticky states, the same convention as the
             * participation templates. A one-star / airbag note measures the
             * loss from the BARRIER instead of par. In this model, that is just
             * put strike = barrier with the raw-shortfall AUTO leverage — no
             * separate payoff mode. See tests/composedProducts.test.ts. */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="btn btn-sm"
                title="Standard geared put from par: loss is measured from 100%."
                onClick={() => setSpec({ putStrikePct: 100, downsideLeveragePct: 100 })}
              >
                Standard
              </button>
              <button
                type="button"
                className="btn btn-sm"
                title="One-star / airbag: loss is measured from the barrier, so breaching it does not immediately cost the full shortfall from par. Sets put strike = barrier with matching leverage."
                onClick={() =>
                  setSpec({
                    putStrikePct: spec.kiBarrierPct,
                    downsideLeveragePct: 10000 / spec.kiBarrierPct,
                  })
                }
              >
                One-star (airbag)
              </button>
            </div>
            {isAirbag && (
              <span className="text-muted" style={{ fontSize: 11 }}>
                Airbag: pays par down to {spec.kiBarrierPct}%, then loses proportionally.
              </span>
            )}
          </div>
        )}
        <div className="field-row">
          <NumericField
            label="Put strike"
            value={spec.putStrikePct}
            step={1}
            suffix="%"
            onChange={(v) => setSpec({ putStrikePct: v })}
            solved={fieldSolved('putStrike')}
            solveChip={canPutStrike}
            solveActive={fieldSolved('putStrike')}
            onSolveClick={() => toggleSolve('putStrike')}
          />
          <NumericField
            label="Downside leverage"
            value={spec.downsideLeveragePct}
            step={5}
            suffix="%"
            onChange={(v) => setSpec({ downsideLeveragePct: v })}
            disabled={leverageAuto}
            badge="AUTO"
            badgeOn={leverageAuto}
            onBadgeClick={() => setLeverageAuto((on) => !on)}
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
                options={freqOptionsFor(spec.tenorYears)}
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
                  solveChip={canCallBarrier}
                  solveActive={fieldSolved('callBarrier')}
                  onSolveClick={() => toggleSolve('callBarrier')}
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
                              {/* A raw input, not a NumericField, because a table
                               * cell has no room for a label row or a stepper
                               * column. The keyboard arrows still snap to a
                               * multiple, and still count as a step edit, so
                               * they match every other field in the app. */}
                              <input
                                className={`input ${validation.rowErrors?.[i] ? 'invalid' : ''}`}
                                type="number"
                                step={1}
                                value={v}
                                onChange={(e) => {
                                  // Ignore a cleared cell mid-retype, rather than
                                  // writing NaN into the barrier schedule.
                                  if (!Number.isFinite(e.target.valueAsNumber)) return;
                                  setBarrierAt(i, e.target.valueAsNumber, 'type');
                                }}
                                onKeyDown={(e) => {
                                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                                  e.preventDefault();
                                  setBarrierAt(i, nextStepValue(v, 1, e.key === 'ArrowUp' ? 1 : -1), 'step');
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
            {spec.callType !== 'none' && (
              <button
                type="button"
                className={`auto-toggle ${couponFreqAuto ? 'on' : ''}`}
                aria-pressed={couponFreqAuto}
                title="Locked to the call (AC) frequency. Turn off to set a coupon frequency that differs from the call schedule."
                onClick={() => setCouponFreqAuto((v) => !v)}
              >
                AUTO
              </button>
            )}
          </div>
          <Segmented<Frequency>
            value={spec.couponFrequency}
            options={
              couponFreqAuto && spec.callType !== 'none'
                ? FREQ_OPTIONS.map((o) => ({ ...o, disabled: true, tooltip: 'Following the call frequency (AUTO).' }))
                : freqOptionsFor(spec.tenorYears)
            }
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
            solveChip={canCouponBarrier}
            solveActive={fieldSolved('couponBarrier')}
            onSolveClick={() => toggleSolve('couponBarrier')}
          />
        )}
        <NumericField
          label="Coupon p.a."
          value={spec.couponPaPct}
          step={0.1}
          suffix="%"
          onChange={(v) => setSpec({ couponPaPct: v })}
          solved={fieldSolved('couponPa')}
          solveChip={canCouponPa}
          solveActive={fieldSolved('couponPa')}
          onSolveClick={() => toggleSolve('couponPa')}
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
              solveChip={canAcCoupon}
              solveActive={fieldSolved('acCouponPa')}
              onSolveClick={() => toggleSolve('acCouponPa')}
            />
          )}
        </Card>
      )}

      {Object.keys(basketValidation.errors).length > 0 && (
        <div style={{ gridColumn: '1 / -1' }} className="status-line error">
          {Object.values(basketValidation.errors).join(' ')}
        </div>
      )}

      <PricingFooter
        page="coupon"
        spec={pricingSpec}
        market={market}
        underlyingName={underlyingName}
        priceLabel={priceLabel}
        priceDisabled={priceDisabled}
        tooltip="Fix validation errors above."
        onRun={handleRun}
        greeks={greeks}
        onGreeksChange={setGreeks}
        running={running}
      />
    </div>
  );
}
