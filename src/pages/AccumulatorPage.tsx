import { useState } from 'react';
import { useTradeStore } from '../state/tradeStore';
import { useMarketStore } from '../state/marketStore';
import { useResultsStore } from '../state/resultsStore';
import { Card } from '../components/Card';
import { Segmented } from '../components/Segmented';
import { NumericField } from '../components/NumericField';
import { SelectField } from '../components/SelectField';
import { ActionRow } from '../components/ActionRow';
import { validateAccumulator } from '../services/validation';
import { runPricing } from '../services/runPricing';
import type { KoSettlement } from '../model/product';
import type { SolveTarget } from '../model/request';

type TenorUnit = 'weeks' | 'months';

const KO_SETTLEMENT_OPTIONS: { value: KoSettlement; label: string }[] = [
  { value: 'ko0', label: 'KO + 0' },
  { value: 'ko1', label: 'KO + 1' },
  { value: 'periodEnd', label: 'Period End' },
];

export function AccumulatorPage() {
  const spec = useTradeStore((s) => s.accumulatorSpec);
  const solve = useTradeStore((s) => s.accumulatorSolve);
  const setSpec = useTradeStore((s) => s.setAccumulatorSpec);
  const setSolve = useTradeStore((s) => s.setAccumulatorSolve);
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const assetType = useMarketStore((s) => s.assetType);
  const running = useResultsStore((s) => s.running);

  const [greeks, setGreeks] = useState(false);
  const [tenorUnit, setTenorUnit] = useState<TenorUnit>('months');
  const [tenorValue, setTenorValue] = useState<number>(6);

  const validation = validateAccumulator(spec, market);
  // Accumulators/decumulators are share-only: the product accumulates a
  // daily number of shares, which has no meaning for an index underlying.
  const indexBlocked = assetType === 'index';
  const priceDisabled = !validation.valid || indexBlocked;
  const priceLabel = solve.kind === 'strike' ? 'Solve' : solve.kind === 'upfront' ? 'Solve' : 'Price';

  function fieldSolved(kind: SolveTarget['kind']): boolean {
    return solve.kind === kind;
  }

  // Accumulator has no 'none' solve state — exactly one of strike/upfront is
  // always the active target. Clicking the inactive chip switches to it;
  // clicking the already-active one is a no-op.
  function selectSolve(kind: 'strike' | 'upfront') {
    setSolve({ kind });
  }

  function setDirection(direction: 'accumulate' | 'decumulate') {
    if (direction === spec.direction) return;
    // Only swap the trigger default if the user hasn't touched it away from
    // the outgoing direction's default (don't clobber a hand-entered value).
    const prevDefault = spec.direction === 'decumulate' ? 90 : 110;
    const nextDefault = direction === 'decumulate' ? 90 : 110;
    const patch: Partial<typeof spec> = { direction };
    if (spec.koTriggerPct === prevDefault) patch.koTriggerPct = nextDefault;
    setSpec(patch);
  }

  function updateTenor(value: number, unit: TenorUnit) {
    setTenorValue(value);
    setTenorUnit(unit);
    const tenorYears = unit === 'weeks' ? value / 52 : value / 12;
    setSpec({ tenorYears });
  }

  function handleRun() {
    runPricing({ page: 'accumulator', product: spec, market, underlyingName, solve, greeks });
  }

  const totalBusinessDays = Math.round(spec.tenorYears * 252);
  const estimatedNotional = spec.dailyShares * totalBusinessDays * (spec.strikePct / 100) * market.spot;

  return (
    <div className="page-grid">
      {indexBlocked && (
        <div className="page-banner error" role="alert">
          Accumulators/Decumulators (AQ/DQ) are share-only — an index underlying cannot be
          accumulated. Set Asset type to Share in the Market Data panel.
        </div>
      )}

      <Card title="Product">
        <div className="field">
          <div className="field-label">
            <span>Product type</span>
          </div>
          <Segmented<'accumulate' | 'decumulate'>
            value={spec.direction}
            options={[
              { value: 'accumulate', label: 'Accumulator' },
              { value: 'decumulate', label: 'Decumulator' },
            ]}
            onChange={setDirection}
          />
        </div>

        <div className="field-row">
          <NumericField
            label="Strike"
            value={spec.strikePct}
            step={1}
            suffix="%"
            onChange={(v) => setSpec({ strikePct: v })}
            solved={fieldSolved('strike')}
            solveChip
            solveActive={fieldSolved('strike')}
            onSolveClick={() => selectSolve('strike')}
          />
          <NumericField
            label="Upfront"
            value={spec.upfrontPct}
            step={0.1}
            suffix="%"
            onChange={(v) => setSpec({ upfrontPct: v })}
            solved={fieldSolved('upfront')}
            solveChip
            solveActive={fieldSolved('upfront')}
            onSolveClick={() => selectSolve('upfront')}
          />
        </div>

        <div className="field">
          <div className="field-label">
            <span>Tenor</span>
          </div>
          <div className="field-row">
            <input
              className="input"
              type="number"
              step={1}
              value={tenorValue}
              onChange={(e) => updateTenor(e.target.valueAsNumber, tenorUnit)}
              style={{ maxWidth: 90 }}
            />
            <Segmented<TenorUnit>
              value={tenorUnit}
              options={[
                { value: 'weeks', label: 'Weeks' },
                { value: 'months', label: 'Months' },
              ]}
              onChange={(v) => updateTenor(tenorValue, v)}
            />
          </div>
          {validation.errors.tenorYears && <span className="field-hint">{validation.errors.tenorYears}</span>}
        </div>

        <div className="computed-readout">
          <span>Estimated notional</span>
          <b>
            {estimatedNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })} {spec.currency}
          </b>
        </div>
      </Card>

      <Card title="Schedule">
        <div className="field">
          <div className="field-label">
            <span>Settlement frequency</span>
          </div>
          <Segmented<'weekly' | 'biweekly' | 'monthly'>
            value={spec.settlementFrequency}
            options={[
              { value: 'weekly', label: 'Weekly' },
              { value: 'biweekly', label: 'Biweekly' },
              { value: 'monthly', label: 'Monthly' },
            ]}
            onChange={(v) => setSpec({ settlementFrequency: v })}
          />
        </div>

        <NumericField
          label="Daily shares"
          value={spec.dailyShares}
          step={1}
          onChange={(v) => setSpec({ dailyShares: v })}
          error={validation.errors.dailyShares}
        />

        <div className="field">
          <div className="field-label">
            <span>Guarantee periods</span>
          </div>
          <div className="stepper">
            <button type="button" onClick={() => setSpec({ guaranteePeriods: Math.max(0, spec.guaranteePeriods - 1) })}>
              −
            </button>
            <input
              className="input"
              type="number"
              value={spec.guaranteePeriods}
              onChange={(e) => setSpec({ guaranteePeriods: Math.max(0, e.target.valueAsNumber || 0) })}
            />
            <button type="button" onClick={() => setSpec({ guaranteePeriods: spec.guaranteePeriods + 1 })}>
              +
            </button>
            <span className="text-muted">settlement periods</span>
          </div>
        </div>
      </Card>

      <Card title="Knock-out">
        <NumericField
          label="KO trigger"
          value={spec.koTriggerPct}
          step={1}
          suffix="%"
          onChange={(v) => setSpec({ koTriggerPct: v })}
          error={validation.errors.koTriggerPct}
        />

        <SelectField
          label="KO settlement"
          value={spec.koSettlement}
          options={KO_SETTLEMENT_OPTIONS}
          onChange={(v) => setSpec({ koSettlement: v as KoSettlement })}
        />

        <div className="field">
          <div className="field-label">
            <span>Gearing</span>
          </div>
          <Segmented<'1' | '2'>
            value={String(spec.gearing) as '1' | '2'}
            options={[
              { value: '1', label: '1x' },
              { value: '2', label: '2x' },
            ]}
            onChange={(v) => setSpec({ gearing: Number(v) as 1 | 2 })}
          />
        </div>
      </Card>

      <div style={{ gridColumn: '1 / -1' }}>
        <ActionRow
          label={priceLabel}
          disabled={priceDisabled}
          tooltip={indexBlocked ? 'Accumulators/Decumulators are share-only — switch Asset type to Share.' : 'Fix validation errors above.'}
          onRun={handleRun}
          greeks={greeks}
          onGreeksChange={setGreeks}
          running={running}
        />
      </div>
    </div>
  );
}
