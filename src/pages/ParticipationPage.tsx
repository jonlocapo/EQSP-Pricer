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
import { runPricing } from '../services/runPricing';
import type { BarrierMonitoring, ParticipationSpec, UpsideVariant } from '../model/product';
import type { SolveTarget } from '../model/request';

/** Standard downside leverage: 1/downsideStrike so a 100% stock decline exhausts the leg. */
function autoDownsideLeverage(downsideStrikePct: number): number {
  if (!(downsideStrikePct > 0)) return 100;
  return Math.round((10000 / downsideStrikePct) * 100) / 100;
}

const AUTO_LEVERAGE_EPS = 0.01;

const PRESET_OPTIONS: ParticipationPreset[] = ['booster', 'bonus', 'capitalGuaranteed', 'twinWin', 'twkg'];

// Structural detection of "which product type does the current spec look
// like" — ignores exact numeric values, only cares about the shape (barrier
// on/off, twin-win/bonus/protection present or not). Order matters: the
// first structural match wins (the definitions are mutually exclusive by
// construction, so in practice only one ever matches).
const PRESET_DETECT: Record<ParticipationPreset, (s: ParticipationSpec) => boolean> = {
  booster: (s) => s.downside.barrierType === 'none' && s.downside.twinWinPct === 0 && s.protectionPct === 0 && s.bonusPct === 0,
  bonus: (s) => s.downside.barrierType !== 'none' && s.bonusPct > 0 && s.downside.twinWinPct === 0 && s.protectionPct === 0,
  capitalGuaranteed: (s) => s.protectionPct > 0 && s.downside.barrierType === 'none' && s.downside.twinWinPct === 0 && s.bonusPct === 0,
  twinWin: (s) => s.downside.barrierType !== 'none' && s.downside.twinWinPct > 0 && s.protectionPct === 0,
  twkg: (s) => s.downside.barrierType !== 'none' && s.downside.twinWinPct > 0 && s.protectionPct > 0,
};

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

  const isCallSpread = spec.upside.variant.variant === 'callSpread';
  const isKoRebate = spec.upside.variant.variant === 'koRebate';
  const hasBarrier = spec.downside.barrierType !== 'none';

  // Whenever a spec change makes the current solve target unavailable, fall
  // back to Price ('none') so no stale solve target reaches the worker.
  useEffect(() => {
    const kind = solve.kind;
    if (kind === 'none') return;
    const available =
      kind === 'gearing' ||
      kind === 'upsideStrike' ||
      kind === 'bonusLevel' ||
      (kind === 'kiBarrier' && hasBarrier) ||
      (kind === 'twinWin' && hasBarrier) ||
      (kind === 'upperStrike' && isCallSpread) ||
      (kind === 'upsideKoBarrier' && isKoRebate) ||
      (kind === 'rebate' && isKoRebate);
    if (!available) setSolve({ kind: 'none' });
  }, [solve.kind, hasBarrier, isCallSpread, isKoRebate, setSolve]);

  const priceDisabled = !validation.valid;
  const priceLabel = solve.kind === 'none' ? 'Price' : 'Solve';

  function fieldSolved(kind: SolveTarget['kind']): boolean {
    return solve.kind === kind;
  }

  // Radio semantics: clicking a chip activates that target and deactivates
  // all others; clicking the already-active chip falls back to Price.
  function toggleSolve(kind: Exclude<SolveTarget['kind'], 'none'>) {
    setSolve(solve.kind === kind ? { kind: 'none' } : ({ kind } as SolveTarget));
  }

  // "Price (reoffer)" is solve kind 'none' — its output is the price shown in
  // the results panel, not a spec field. The Reoffer field is the closest
  // analogue of that output (the target price the solve engine matches), so
  // dim it the same way the other solve targets dim their own field.
  const priceIsSolveTarget = solve.kind === 'none';

  const detectedPreset = PRESET_OPTIONS.find((p) => PRESET_DETECT[p](spec));

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

  const kgKiNeverBites = spec.protectionPct >= 100 && spec.downside.barrierType !== 'none' && spec.downside.twinWinPct === 0;

  return (
    <div className="page-grid">
      <div className="field" style={{ gridColumn: '1 / -1' }}>
        <div className="field-label">
          <span>Product type</span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {PRESET_OPTIONS.map((p) => (
            <button
              key={p}
              type="button"
              className={`btn btn-sm ${detectedPreset === p ? 'btn-active' : ''}`}
              onClick={() => applyPreset(p)}
            >
              {PARTICIPATION_PRESET_LABELS[p]}
            </button>
          ))}
          <span className={`pill ${detectedPreset ? '' : 'pill-active'}`}>Custom</span>
        </div>
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
        <div className="field-row">
          <NumericField
            label="Reoffer"
            value={spec.reofferPct}
            step={0.1}
            suffix="%"
            onChange={(v) => patchSpec({ reofferPct: v })}
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
            solveChip
            solveActive={fieldSolved('upsideStrike')}
            onSolveClick={() => toggleSolve('upsideStrike')}
          />
          <NumericField
            label="Participation"
            value={spec.upside.participationPct}
            step={5}
            suffix="%"
            onChange={(v) => patchUpside({ participationPct: v })}
            solved={fieldSolved('gearing')}
            solveChip
            solveActive={fieldSolved('gearing')}
            onSolveClick={() => toggleSolve('gearing')}
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
            solveChip
            solveActive={fieldSolved('upperStrike')}
            onSolveClick={() => toggleSolve('upperStrike')}
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
              solveChip
              solveActive={fieldSolved('upsideKoBarrier')}
              onSolveClick={() => toggleSolve('upsideKoBarrier')}
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
              solveChip
              solveActive={fieldSolved('rebate')}
              onSolveClick={() => toggleSolve('rebate')}
            />
          </>
        )}
        <NumericField
          label="Bonus"
          value={spec.bonusPct}
          step={1}
          suffix="%"
          onChange={(v) => patchSpec({ bonusPct: v })}
          solved={fieldSolved('bonusLevel')}
          solveChip
          solveActive={fieldSolved('bonusLevel')}
          onSolveClick={() => toggleSolve('bonusLevel')}
        />
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
          <NumericField
            label="KI level"
            value={spec.downside.kiBarrierPct}
            step={1}
            suffix="%"
            onChange={(v) => patchDownside({ kiBarrierPct: v })}
            error={validation.errors.kiBarrierPct}
            solved={fieldSolved('kiBarrier')}
            solveChip
            solveActive={fieldSolved('kiBarrier')}
            onSolveClick={() => toggleSolve('kiBarrier')}
          />
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
        {spec.downside.barrierType !== 'none' && (
          <NumericField
            label="Twin-win participation"
            value={spec.downside.twinWinPct}
            step={5}
            suffix="%"
            onChange={(v) => patchDownside({ twinWinPct: v })}
            solved={fieldSolved('twinWin')}
            solveChip
            solveActive={fieldSolved('twinWin')}
            onSolveClick={() => toggleSolve('twinWin')}
          />
        )}
        <NumericField
          label="Protection"
          value={spec.protectionPct}
          step={1}
          suffix="%"
          onChange={(v) => patchSpec({ protectionPct: v })}
        />
        {kgKiNeverBites && (
          <span className="text-muted" style={{ fontSize: 11 }}>
            With 100% protection the KI downside never bites — combine with twin-win (TWKG) or drop one.
          </span>
        )}
      </Card>

      <div style={{ gridColumn: '1 / -1' }}>
        <ActionRow
          label={priceLabel}
          disabled={priceDisabled}
          tooltip="Fix validation errors above."
          onRun={handleRun}
          greeks={greeks}
          onGreeksChange={setGreeks}
          running={running}
        />
      </div>
    </div>
  );
}
