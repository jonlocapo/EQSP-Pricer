import { useEffect, useState } from 'react';
import { useTradeStore, PARTICIPATION_PRESET_LABELS, type ParticipationPreset } from '../state/tradeStore';
import { useMarketStore } from '../state/marketStore';
import { useResultsStore } from '../state/resultsStore';
import { Card } from '../components/Card';
import { Segmented } from '../components/Segmented';
import { NumericField } from '../components/NumericField';
import { TenorField } from '../components/TenorField';
import { Toggle } from '../components/Toggle';
import { ActionRow } from '../components/ActionRow';
import { validateParticipation } from '../services/validation';
import { participationSolveOptions } from '../services/solveOptions';
import { runPricing } from '../services/runPricing';
import type { BarrierMonitoring, UpsideVariant } from '../model/product';
import type { SolveTarget } from '../model/request';

/** Standard downside leverage: 1/downsideStrike so a 100% stock decline exhausts the leg. */
function autoDownsideLeverage(downsideStrikePct: number): number {
  if (!(downsideStrikePct > 0)) return 100;
  return Math.round((10000 / downsideStrikePct) * 100) / 100;
}

const AUTO_LEVERAGE_EPS = 0.01;

const PRESET_OPTIONS: ParticipationPreset[] = ['booster', 'bonus', 'capitalGuaranteed', 'twinWin'];

export function ParticipationPage() {
  const spec = useTradeStore((s) => s.participationSpec);
  const solve = useTradeStore((s) => s.participationSolve);
  const patchSpec = useTradeStore((s) => s.patchParticipationSpec);
  const applyPreset = useTradeStore((s) => s.applyParticipationPreset);
  const setSolve = useTradeStore((s) => s.setParticipationSolve);
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const running = useResultsStore((s) => s.running);

  const [greeks, setGreeks] = useState(false);
  const [lastLowerStrike, setLastLowerStrike] = useState(90);
  const [leverageAuto, setLeverageAuto] = useState(true);

  // When AUTO is on, downside leverage is locked to 1/downsideStrike and
  // recomputed whenever the downside strike changes or AUTO is toggled on
  // (mirrors the RC/AC coupon page's put-strike tracking). Guarded so it only
  // writes when the value actually differs, to avoid redundant re-renders.
  useEffect(() => {
    if (!leverageAuto) return;
    const auto = autoDownsideLeverage(spec.downside.strikePct);
    if (Math.abs(spec.downside.leveragePct - auto) >= AUTO_LEVERAGE_EPS) {
      patchSpec({ downside: { ...spec.downside, leveragePct: auto } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leverageAuto, spec.downside.strikePct]);

  const validation = validateParticipation(spec, market);
  const solveOptions = participationSolveOptions(spec);
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

  function patchUpside(patch: Partial<{ strikePct: number; participationPct: number }>) {
    patchSpec({ upside: { ...spec.upside, ...patch } });
  }

  function patchUpsideVariant(patch: Partial<UpsideVariant>) {
    patchSpec({ upside: { ...spec.upside, variant: { ...spec.upside.variant, ...patch } as UpsideVariant } });
  }

  function patchDownside(patch: Partial<typeof spec.downside>) {
    patchSpec({ downside: { ...spec.downside, ...patch } });
  }

  function handleRun() {
    runPricing({ page: 'participation', product: spec, market, underlyingName, solve, greeks });
  }

  return (
    <div className="page-grid">
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
        {PRESET_OPTIONS.map((p) => (
          <button key={p} type="button" className="btn btn-sm" onClick={() => applyPreset(p)}>
            {PARTICIPATION_PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      <Card title="General Terms">
        <NumericField
          label="Notional"
          value={spec.notional}
          step={10000}
          suffix={spec.currency}
          onChange={(v) => patchSpec({ notional: v })}
          error={validation.errors.notional}
        />
        <TenorField
          years={spec.tenorYears}
          onChange={(v) => patchSpec({ tenorYears: v })}
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
            onChange={(v) => patchSpec({ reofferPct: v })}
            solved={priceIsSolveTarget}
          />
          <NumericField
            label="Issue price"
            value={spec.issuePricePct}
            step={0.1}
            suffix="%"
            onChange={(v) => patchSpec({ issuePricePct: v })}
          />
        </div>
      </Card>

      <Card title="Upside">
        <div className="field-row">
          <NumericField
            label="Strike"
            value={spec.upside.strikePct}
            step={1}
            suffix="%"
            onChange={(v) => patchUpside({ strikePct: v })}
            solved={fieldSolved('upsideStrike')}
          />
          <NumericField
            label="Participation"
            value={spec.upside.participationPct}
            step={5}
            suffix="%"
            onChange={(v) => patchUpside({ participationPct: v })}
            solved={fieldSolved('gearing')}
          />
        </div>
        <div className="field">
          <div className="field-label">
            <span>Variant</span>
          </div>
          <Segmented<UpsideVariant['variant']>
            value={spec.upside.variant.variant}
            options={[
              { value: 'vanilla', label: 'Vanilla' },
              { value: 'callSpread', label: 'Call Spread' },
              { value: 'koRebate', label: 'KO + Rebate' },
            ]}
            onChange={(v) => {
              if (v === 'vanilla') patchUpsideVariant({ variant: 'vanilla' });
              else if (v === 'callSpread') patchUpsideVariant({ variant: 'callSpread', upperStrikePct: 120 } as never);
              else
                patchUpsideVariant({
                  variant: 'koRebate',
                  koBarrierPct: 120,
                  koMonitoring: 'american',
                  rebatePct: 5,
                } as never);
            }}
          />
        </div>
        {spec.upside.variant.variant === 'callSpread' && (
          <NumericField
            label="Upper strike"
            value={spec.upside.variant.upperStrikePct}
            step={1}
            suffix="%"
            onChange={(v) => patchUpsideVariant({ upperStrikePct: v } as never)}
            error={validation.errors.upperStrikePct}
            solved={fieldSolved('upperStrike')}
          />
        )}
        {spec.upside.variant.variant === 'koRebate' && (
          <>
            <NumericField
              label="KO barrier"
              value={spec.upside.variant.koBarrierPct}
              step={1}
              suffix="%"
              onChange={(v) => patchUpsideVariant({ koBarrierPct: v } as never)}
              error={validation.errors.koBarrierPct}
              solved={fieldSolved('upsideKoBarrier')}
            />
            <div className="field">
              <div className="field-label">
                <span>Monitoring</span>
              </div>
              <Segmented<'american' | 'european'>
                value={spec.upside.variant.koMonitoring}
                options={[
                  { value: 'american', label: 'American' },
                  { value: 'european', label: 'European' },
                ]}
                onChange={(v) => patchUpsideVariant({ koMonitoring: v } as never)}
              />
            </div>
            <NumericField
              label="Rebate"
              value={spec.upside.variant.rebatePct}
              step={1}
              suffix="%"
              onChange={(v) => patchUpsideVariant({ rebatePct: v } as never)}
              solved={fieldSolved('rebate')}
            />
          </>
        )}
      </Card>

      <Card title="Downside">
        <div className="field-row">
          <NumericField
            label="Strike"
            value={spec.downside.strikePct}
            step={1}
            suffix="%"
            onChange={(v) => patchDownside({ strikePct: v })}
          />
          <NumericField
            label="Leverage"
            value={spec.downside.leveragePct}
            step={5}
            suffix="%"
            onChange={(v) => patchDownside({ leveragePct: v })}
            disabled={leverageAuto}
            badge="AUTO"
            badgeOn={leverageAuto}
            onBadgeClick={() => setLeverageAuto((on) => !on)}
          />
        </div>
        <div className="field">
          <div className="field-label">
            <span>KI Barrier</span>
          </div>
          <Segmented<BarrierMonitoring>
            value={spec.downside.barrierType}
            options={[
              { value: 'none', label: 'None' },
              { value: 'european', label: 'European' },
              { value: 'american', label: 'American' },
            ]}
            onChange={(v) => patchDownside({ barrierType: v })}
          />
        </div>
        {spec.downside.barrierType !== 'none' && (
          <>
            <NumericField
              label="KI level"
              value={spec.downside.kiBarrierPct}
              step={1}
              suffix="%"
              onChange={(v) => patchDownside({ kiBarrierPct: v })}
              error={validation.errors.kiBarrierPct}
              solved={fieldSolved('kiBarrier')}
            />
            <NumericField
              label="Twin-win participation"
              value={spec.downside.twinWinPct}
              step={5}
              suffix="%"
              onChange={(v) => patchDownside({ twinWinPct: v })}
              solved={fieldSolved('twinWin')}
              hint="Positive participation in the downside while not knocked in. 0 = off."
            />
          </>
        )}
        <Toggle
          label="Put spread floor"
          checked={!!spec.downside.putSpread}
          onChange={(on) => {
            if (on) {
              patchDownside({ putSpread: { lowerStrikePct: lastLowerStrike } });
            } else {
              if (spec.downside.putSpread) setLastLowerStrike(spec.downside.putSpread.lowerStrikePct);
              patchDownside({ putSpread: undefined });
            }
          }}
        />
        {spec.downside.putSpread && (
          <NumericField
            label="Lower strike"
            value={spec.downside.putSpread.lowerStrikePct}
            step={1}
            suffix="%"
            onChange={(v) => patchDownside({ putSpread: { lowerStrikePct: v } })}
            error={validation.errors.lowerStrikePct}
          />
        )}
      </Card>

      <Card title="Bonus & Protection">
        <div className="field-row">
          <NumericField
            label="Bonus"
            value={spec.bonusPct}
            step={1}
            suffix="%"
            onChange={(v) => patchSpec({ bonusPct: v })}
            solved={fieldSolved('bonusLevel')}
            hint="Amount above par, e.g. 15 = 115% if not knocked in. 0 = none."
          />
          <NumericField
            label="Protection"
            value={spec.protectionPct}
            step={1}
            suffix="%"
            onChange={(v) => patchSpec({ protectionPct: v })}
            hint="Capital protection floor, % of notional. 0 = none."
          />
        </div>
      </Card>

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
