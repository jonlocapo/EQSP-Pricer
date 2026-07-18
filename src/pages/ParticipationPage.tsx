import { useEffect, useRef, useState } from 'react';
import { useTradeStore } from '../state/tradeStore';
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
import type { BarrierMonitoring, ParticipationSubtype, UpsideVariant } from '../model/product';
import type { SolveTarget } from '../model/request';

/** Standard downside leverage: 1/downsideStrike so a 100% stock decline exhausts the leg. */
function autoDownsideLeverage(downsideStrikePct: number): number {
  if (!(downsideStrikePct > 0)) return 100;
  return Math.round((10000 / downsideStrikePct) * 100) / 100;
}

const AUTO_LEVERAGE_EPS = 0.01;

const SUBTYPE_OPTIONS: { value: ParticipationSubtype; label: string }[] = [
  { value: 'booster', label: 'Booster' },
  { value: 'bonus', label: 'Bonus' },
  { value: 'capitalGuaranteed', label: 'Capital Guaranteed' },
  { value: 'twinWin', label: 'Twin Win' },
];

export function ParticipationPage() {
  const subtype = useTradeStore((s) => s.participationSubtype);
  const drafts = useTradeStore((s) => s.participationDrafts);
  const solve = useTradeStore((s) => s.participationSolve);
  const setSubtype = useTradeStore((s) => s.setParticipationSubtype);
  const patchDraft = useTradeStore((s) => s.patchParticipationDraft);
  const setSolve = useTradeStore((s) => s.setParticipationSolve);
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const running = useResultsStore((s) => s.running);

  const [greeks, setGreeks] = useState(false);
  const [lastLowerStrike, setLastLowerStrike] = useState(90);

  const spec = drafts[subtype];

  // Booster downside leverage auto-tracks 1/downsideStrike until the user
  // types a value that diverges from it (mirrors the RC/AC coupon page's
  // put-strike tracking).
  const prevDownsideStrikeRef = useRef(drafts.booster.downsideStrikePct);
  useEffect(() => {
    const prevStrike = prevDownsideStrikeRef.current;
    const boosterSpec = drafts.booster;
    if (prevStrike !== boosterSpec.downsideStrikePct) {
      const autoForOld = autoDownsideLeverage(prevStrike);
      if (Math.abs(boosterSpec.downsideLeveragePct - autoForOld) < AUTO_LEVERAGE_EPS) {
        patchDraft('booster', { downsideLeveragePct: autoDownsideLeverage(boosterSpec.downsideStrikePct) });
      }
      prevDownsideStrikeRef.current = boosterSpec.downsideStrikePct;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts.booster.downsideStrikePct]);

  const validation = validateParticipation(spec, market);
  const solveOptions = participationSolveOptions(spec);
  const currentSolveOpt = solveOptions.find((o) => o.value === solve.kind);
  const priceDisabled = !validation.valid || (currentSolveOpt?.disabled ?? false);
  const priceLabel = solve.kind === 'none' ? 'Price' : 'Solve';

  function fieldSolved(kind: SolveTarget['kind']): boolean {
    return solve.kind === kind;
  }

  function patchUpside(patch: Partial<UpsideVariant>) {
    patchDraft(subtype, { upside: { ...spec.upside, ...patch } as UpsideVariant } as never);
  }

  function handleRun() {
    runPricing({ page: 'participation', product: spec, market, underlyingName, solve, greeks });
  }

  return (
    <div className="page-grid">
      <div style={{ gridColumn: '1 / -1' }}>
        <Segmented<ParticipationSubtype>
          value={subtype}
          options={SUBTYPE_OPTIONS}
          onChange={(v) => {
            setSubtype(v);
            setSolve({ kind: 'none' });
          }}
        />
      </div>

      <Card title="General Terms">
        <NumericField
          label="Notional"
          value={spec.notional}
          step={10000}
          suffix={spec.currency}
          onChange={(v) => patchDraft(subtype, { notional: v } as never)}
          error={validation.errors.notional}
        />
        <TenorField
          years={spec.tenorYears}
          onChange={(v) => patchDraft(subtype, { tenorYears: v } as never)}
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
            onChange={(v) => patchDraft(subtype, { reofferPct: v } as never)}
          />
          <NumericField
            label="Issue price"
            value={spec.issuePricePct}
            step={0.1}
            suffix="%"
            onChange={(v) => patchDraft(subtype, { issuePricePct: v } as never)}
          />
        </div>
      </Card>

      <Card title={SUBTYPE_OPTIONS.find((o) => o.value === subtype)!.label}>
        {spec.subtype === 'booster' && (
          <>
            <div className="field-row">
              <NumericField
                label="Strike"
                value={spec.strikePct}
                step={1}
                suffix="%"
                onChange={(v) => patchDraft('booster', { strikePct: v })}
              />
              <NumericField
                label="Gearing"
                value={spec.gearingPct}
                step={5}
                suffix="%"
                onChange={(v) => patchDraft('booster', { gearingPct: v })}
                solved={fieldSolved('gearing')}
              />
            </div>
            <div className="field-row">
              <NumericField
                label="Downside strike"
                value={spec.downsideStrikePct}
                step={1}
                suffix="%"
                onChange={(v) => patchDraft('booster', { downsideStrikePct: v })}
              />
              <NumericField
                label="Downside leverage"
                value={spec.downsideLeveragePct}
                step={5}
                suffix="%"
                onChange={(v) => patchDraft('booster', { downsideLeveragePct: v })}
                badge={
                  Math.abs(spec.downsideLeveragePct - autoDownsideLeverage(spec.downsideStrikePct)) < AUTO_LEVERAGE_EPS
                    ? 'AUTO'
                    : undefined
                }
              />
            </div>
            <div className="field">
              <div className="field-label">
                <span>Barrier</span>
              </div>
              <Segmented<BarrierMonitoring>
                value={spec.barrierType}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'european', label: 'European' },
                  { value: 'american', label: 'American' },
                ]}
                onChange={(v) => patchDraft('booster', { barrierType: v })}
              />
            </div>
            {spec.barrierType !== 'none' && (
              <NumericField
                label="KI barrier"
                value={spec.kiBarrierPct}
                step={1}
                suffix="%"
                onChange={(v) => patchDraft('booster', { kiBarrierPct: v })}
              />
            )}
          </>
        )}

        {spec.subtype === 'bonus' && (
          <>
            <NumericField
              label="Bonus level"
              value={spec.bonusLevelPct}
              step={1}
              suffix="%"
              onChange={(v) => patchDraft('bonus', { bonusLevelPct: v })}
              solved={fieldSolved('bonusLevel')}
            />
            <div className="field">
              <div className="field-label">
                <span>Barrier</span>
              </div>
              <Segmented<'european' | 'american'>
                value={spec.barrierType}
                options={[
                  { value: 'european', label: 'European' },
                  { value: 'american', label: 'American' },
                ]}
                onChange={(v) => patchDraft('bonus', { barrierType: v })}
              />
            </div>
            <NumericField
              label="KI barrier"
              value={spec.kiBarrierPct}
              step={1}
              suffix="%"
              onChange={(v) => patchDraft('bonus', { kiBarrierPct: v })}
            />
          </>
        )}

        {spec.subtype === 'capitalGuaranteed' && (
          <>
            <NumericField
              label="Protection"
              value={spec.protectionPct}
              step={1}
              suffix="%"
              onChange={(v) => patchDraft('capitalGuaranteed', { protectionPct: v })}
            />
            <NumericField
              label="Strike"
              value={spec.strikePct}
              step={1}
              suffix="%"
              onChange={(v) => patchDraft('capitalGuaranteed', { strikePct: v })}
            />
            <NumericField
              label="Participation"
              value={spec.participationPct}
              step={5}
              suffix="%"
              onChange={(v) => patchDraft('capitalGuaranteed', { participationPct: v })}
              solved={fieldSolved('participation')}
            />
          </>
        )}

        {spec.subtype === 'twinWin' && (
          <>
            <div className="field-row">
              <NumericField
                label="Part up"
                value={spec.partUpPct}
                step={5}
                suffix="%"
                onChange={(v) => patchDraft('twinWin', { partUpPct: v })}
                solved={fieldSolved('partUp')}
              />
              <NumericField
                label="Part down"
                value={spec.partDownPct}
                step={5}
                suffix="%"
                onChange={(v) => patchDraft('twinWin', { partDownPct: v })}
              />
            </div>
            <div className="field">
              <div className="field-label">
                <span>Barrier</span>
              </div>
              <Segmented<'european' | 'american'>
                value={spec.barrierType}
                options={[
                  { value: 'european', label: 'European' },
                  { value: 'american', label: 'American' },
                ]}
                onChange={(v) => patchDraft('twinWin', { barrierType: v })}
              />
            </div>
            <NumericField
              label="KI barrier"
              value={spec.kiBarrierPct}
              step={1}
              suffix="%"
              onChange={(v) => patchDraft('twinWin', { kiBarrierPct: v })}
            />
          </>
        )}
      </Card>

      <Card title="Upside">
        <div className="field">
          <div className="field-label">
            <span>Variant</span>
          </div>
          <Segmented<UpsideVariant['variant']>
            value={spec.upside.variant}
            options={[
              { value: 'vanilla', label: 'Vanilla' },
              { value: 'callSpread', label: 'Call Spread' },
              { value: 'koRebate', label: 'KO + Rebate' },
            ]}
            onChange={(v) => {
              if (v === 'vanilla') patchUpside({ variant: 'vanilla' });
              else if (v === 'callSpread') patchUpside({ variant: 'callSpread', upperStrikePct: 120 } as never);
              else patchUpside({ variant: 'koRebate', koBarrierPct: 120, koMonitoring: 'american', rebatePct: 5 } as never);
            }}
          />
        </div>
        {spec.upside.variant === 'callSpread' && (
          <NumericField
            label="Upper strike"
            value={spec.upside.upperStrikePct}
            step={1}
            suffix="%"
            onChange={(v) => patchUpside({ upperStrikePct: v } as never)}
            error={validation.errors.upperStrikePct}
            solved={fieldSolved('upperStrike')}
          />
        )}
        {spec.upside.variant === 'koRebate' && (
          <>
            <NumericField
              label="KO barrier"
              value={spec.upside.koBarrierPct}
              step={1}
              suffix="%"
              onChange={(v) => patchUpside({ koBarrierPct: v } as never)}
              error={validation.errors.koBarrierPct}
              solved={fieldSolved('upsideKoBarrier')}
            />
            <div className="field">
              <div className="field-label">
                <span>Monitoring</span>
              </div>
              <Segmented<'american' | 'european'>
                value={spec.upside.koMonitoring}
                options={[
                  { value: 'american', label: 'American' },
                  { value: 'european', label: 'European' },
                ]}
                onChange={(v) => patchUpside({ koMonitoring: v } as never)}
              />
            </div>
            <NumericField
              label="Rebate"
              value={spec.upside.rebatePct}
              step={1}
              suffix="%"
              onChange={(v) => patchUpside({ rebatePct: v } as never)}
              solved={fieldSolved('rebate')}
            />
          </>
        )}
      </Card>

      {subtype !== 'capitalGuaranteed' && (
        <Card title="Downside">
          <Toggle
            label="Put spread floor"
            checked={!!spec.downsidePutSpread}
            onChange={(on) => {
              if (on) {
                patchDraft(subtype, { downsidePutSpread: { lowerStrikePct: lastLowerStrike } } as never);
              } else {
                if (spec.downsidePutSpread) setLastLowerStrike(spec.downsidePutSpread.lowerStrikePct);
                patchDraft(subtype, { downsidePutSpread: undefined } as never);
              }
            }}
          />
          {spec.downsidePutSpread && (
            <NumericField
              label="Lower strike"
              value={spec.downsidePutSpread.lowerStrikePct}
              step={1}
              suffix="%"
              onChange={(v) => patchDraft(subtype, { downsidePutSpread: { lowerStrikePct: v } } as never)}
              error={validation.errors.lowerStrikePct}
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
