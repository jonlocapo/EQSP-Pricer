import { useEffect, useRef, useState } from 'react';
import { useTradeStore, PARTICIPATION_PRESET_LABELS, type ParticipationPreset } from '../state/tradeStore';
import { useMarketStore } from '../state/marketStore';
import { useResultsStore } from '../state/resultsStore';
import { Card } from '../components/Card';
import { Segmented } from '../components/Segmented';
import { NumericField } from '../components/NumericField';
import { TenorField } from '../components/TenorField';
import { PricingFooter } from '../components/PricingFooter';
import { validateParticipation, validateBasket } from '../services/validation';
import { runPricing } from '../services/runPricing';
import { useLiveReprice } from '../hooks/useLiveReprice';
import { AUTO_LEVERAGE_EPS, autoDownsideLeverage, makeFieldSolved, makeToggleSolve, priceLabelFor, usePricingSpec } from './pageHelpers';
import type { BarrierMonitoring, UpsideVariant } from '../model/product';

const PRESET_OPTIONS: ParticipationPreset[] = ['booster', 'bonus', 'capitalGuaranteed', 'twinWin', 'twkg'];

export function ParticipationPage() {
  const spec = useTradeStore((s) => s.participationSpec);
  const solve = useTradeStore((s) => s.participationSolve);
  const patchSpec = useTradeStore((s) => s.patchParticipationSpec);
  const applyPreset = useTradeStore((s) => s.applyParticipationPreset);
  const setSolve = useTradeStore((s) => s.setParticipationSolve);
  const market = useMarketStore((s) => s.market);
  const basketCorrelation = useMarketStore((s) => s.basketCorrelation);
  const running = useResultsStore((s) => s.running);

  // See pageHelpers.usePricingSpec: the live leg list, assembled fresh each
  // render, rather than a stored spec field the basket panel would have to
  // keep in sync.
  const { underlyingName, legsForValidation, pricingSpec } = usePricingSpec(spec);

  const [greeks, setGreeks] = useState(false);
  const [leverageAuto, setLeverageAuto] = useState(true);

  // Downside feature toggles — KI Barrier, Put Spread, Twin Win, KG — are
  // DERIVED from the spec, not duplicated state. A toggle is "on" only when
  // its underlying field is in its non-default state. Refs remember the
  // last non-default value for each feature, purely so re-enabling
  // restores what the user had before. Reset on page reload is fine;
  // nothing here is persisted.
  const lastBarrierType = useRef<'european' | 'american'>('american');
  const lastKiLevel = useRef(65);
  const lastLowerStrike = useRef(50);
  const lastTwinWinPct = useRef(100);
  const lastProtectionPct = useRef(100);

  /**
   * Which feature a conflicting toggle SWITCHED OFF on the user's behalf, so
   * turning that toggle back off can put it back.
   *
   * KG and a bare KI barrier are mutually exclusive outside Twin Win KG, so
   * enabling one drops the other. Every toggle here already restores its OWN
   * last value from a `last*` ref, but none of them restored the value they
   * took from a NEIGHBOUR. Enabling KG dropped the KI barrier and disabling
   * KG left it dropped, so the downside the user had built never came back and
   * they had to rebuild it by hand.
   */
  const kgDroppedKi = useRef(false);
  const kiDroppedKg = useRef(false);

  useEffect(() => {
    if (spec.downside.barrierType !== 'none') lastBarrierType.current = spec.downside.barrierType;
  }, [spec.downside.barrierType]);
  useEffect(() => {
    if (spec.downside.barrierType !== 'none') lastKiLevel.current = spec.downside.kiBarrierPct;
  }, [spec.downside.barrierType, spec.downside.kiBarrierPct]);
  useEffect(() => {
    if (spec.downside.putSpread) lastLowerStrike.current = spec.downside.putSpread.lowerStrikePct;
  }, [spec.downside.putSpread]);
  useEffect(() => {
    if (spec.downside.twinWinPct > 0) lastTwinWinPct.current = spec.downside.twinWinPct;
  }, [spec.downside.twinWinPct]);
  useEffect(() => {
    if (spec.protectionPct > 0) lastProtectionPct.current = spec.protectionPct;
  }, [spec.protectionPct]);

  // When AUTO is on, downside leverage is locked to 1/downsideStrike, and
  // recomputed whenever the downside strike changes or AUTO is toggled on.
  // This mirrors the RC/AC coupon page's put-strike tracking. Guarded so it
  // only writes when the value actually differs, to avoid redundant
  // re-renders.
  useEffect(() => {
    // AUTO MUST ACTUALLY ENFORCE. This used to watch only the strike and the
    // toggle, so anything that wrote `leveragePct` from elsewhere stuck. The
    // Capital Guaranteed preset writes 0 — correct for that product, since a
    // guaranteed note has no downside participation — and the strike does not
    // move, so the effect never re-ran. AUTO stayed lit, the field stayed
    // disabled so nobody could type it back, and the leverage sat at 0. Switch
    // the note back off capital guarantee and the put had no leverage at all:
    // the downside was silently gone from a note that is supposed to have one.
    // Watching the value itself makes the badge tell the truth.
    if (!leverageAuto) return;
    const auto = autoDownsideLeverage(spec.downside.strikePct);
    if (Math.abs(spec.downside.leveragePct - auto) >= AUTO_LEVERAGE_EPS) {
      patchSpec({ downside: { ...spec.downside, leveragePct: auto } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leverageAuto, spec.downside.strikePct, spec.downside.leveragePct]);

  const validation = validateParticipation(spec, market);
  const basketValidation = validateBasket(legsForValidation, basketCorrelation, market);

  const isCallSpread = spec.upside.variant.variant === 'callSpread';
  const isKoRebate = spec.upside.variant.variant === 'koRebate';
  const hasBarrier = spec.downside.barrierType !== 'none';

  // Whenever a spec change makes the current solve target unavailable, fall
  // back to Price ('none'), so no stale solve target reaches the worker.
  useEffect(() => {
    const kind = solve.kind;
    if (kind === 'none') return;
    const available =
      kind === 'gearing' ||
      kind === 'upsideStrike' ||
      (kind === 'bonusLevel' && hasBarrier) ||
      (kind === 'kiBarrier' && hasBarrier) ||
      (kind === 'twinWin' && hasBarrier) ||
      (kind === 'upperStrike' && isCallSpread) ||
      (kind === 'upsideKoBarrier' && isKoRebate) ||
      (kind === 'rebate' && isKoRebate);
    if (!available) setSolve({ kind: 'none' });
  }, [solve.kind, hasBarrier, isCallSpread, isKoRebate, setSolve]);

  const priceDisabled = !validation.valid || !basketValidation.valid;
  const priceLabel = priceLabelFor(solve);

  useLiveReprice({
    page: 'participation',
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

  function patchUpside(patch: Partial<{ strikePct: number; participationPct: number }>) {
    patchSpec({ upside: { ...spec.upside, ...patch } });
  }

  function patchUpsideVariant(patch: Partial<UpsideVariant>) {
    patchSpec({ upside: { ...spec.upside, variant: { ...spec.upside.variant, ...patch } as UpsideVariant } });
  }

  function patchDownside(patch: Partial<typeof spec.downside>) {
    patchSpec({ downside: { ...spec.downside, ...patch } });
  }

  const kiOn = spec.downside.barrierType !== 'none';
  const psOn = !!spec.downside.putSpread;
  const twOn = spec.downside.twinWinPct > 0;
  const kgOn = spec.protectionPct > 0;

  // KI Barrier and KG (capital protection) are mutually exclusive UNLESS
  // Twin Win is active — TWKG means twin-win, KG, and KI can coexist. A
  // plain KI barrier and a capital-guarantee floor describe contradictory
  // downside shapes. But twin-win's "not knocked-in" branch never touches
  // the KG floor at all; it is always >= 100. So once twin-win is live,
  // there is no actual conflict between the three.
  function toggleKI() {
    if (kiOn) {
      const patch: Partial<typeof spec.downside> = { barrierType: 'none' };
      // Twin-win and bonus only make sense while knocked-in monitoring is live.
      if (spec.downside.twinWinPct > 0) patch.twinWinPct = 0;
      // Remember the barrier being switched off, so KG's restore has
      // something true to put back rather than the initial default.
      lastBarrierType.current = spec.downside.barrierType === 'american' ? 'american' : 'european';
      lastKiLevel.current = spec.downside.kiBarrierPct;
      patchDownside(patch);
      if (spec.bonusPct > 0) patchSpec({ bonusPct: 0 });
      // Hand KG back if enabling KI is what took it away.
      if (kiDroppedKg.current) {
        kiDroppedKg.current = false;
        patchSpec({ protectionPct: lastProtectionPct.current });
      }
      kgDroppedKi.current = false;
    } else {
      // Enabling KI while off implies twin-win was already off, because it
      // requires KI. So the only conflict to resolve is a bare KG floor.
      patchDownside({ barrierType: lastBarrierType.current, kiBarrierPct: lastKiLevel.current });
      // Same trade in the other direction: KI displaces KG, so remember that
      // it did and hand KG back when KI goes away again.
      if (kgOn) {
        lastProtectionPct.current = spec.protectionPct;
        kiDroppedKg.current = true;
        patchSpec({ protectionPct: 0 });
      }
      kgDroppedKi.current = false;
    }
  }

  function togglePutSpread() {
    if (psOn) {
      patchDownside({ putSpread: undefined });
    } else {
      patchDownside({ putSpread: { lowerStrikePct: lastLowerStrike.current } });
    }
  }

  function toggleTwinWin() {
    if (twOn) {
      patchDownside({ twinWinPct: 0 });
      // The KI+KG exception only holds while twin-win is live. Once it drops,
      // resolve the now-reinstated conflict by clearing KG. The KI barrier is
      // the more structural of the two.
      if (kgOn) patchSpec({ protectionPct: 0 });
    } else if (!kiOn) {
      // Twin Win requires a KI barrier. The most user-friendly behavior is to
      // auto-enable KI with a sensible default, rather than leaving the
      // control inert or blocking the click with an error.
      patchDownside({
        barrierType: lastBarrierType.current,
        kiBarrierPct: lastKiLevel.current,
        twinWinPct: lastTwinWinPct.current,
      });
    } else {
      patchDownside({ twinWinPct: lastTwinWinPct.current });
    }
  }

  function toggleKG() {
    if (kgOn) {
      patchSpec({ protectionPct: 0 });
      // Put back the KI barrier that enabling KG took away. Only when KG was
      // what removed it: a user who turned KI off themselves before touching
      // KG wants it to stay off.
      if (kgDroppedKi.current) {
        kgDroppedKi.current = false;
        patchDownside({ barrierType: lastBarrierType.current, kiBarrierPct: lastKiLevel.current });
      }
    } else {
      patchSpec({ protectionPct: lastProtectionPct.current });
      // Enabling KG while a bare KI barrier, with no twin-win, is live. The
      // two are mutually exclusive outside of TWKG. So drop the KI barrier,
      // and REMEMBER that KG is the reason, so turning KG off restores it.
      if (kiOn && !twOn) {
        const patch: Partial<typeof spec.downside> = { barrierType: 'none' };
        if (spec.downside.twinWinPct > 0) patch.twinWinPct = 0;
        lastBarrierType.current = spec.downside.barrierType === 'american' ? 'american' : 'european';
        lastKiLevel.current = spec.downside.kiBarrierPct;
        kgDroppedKi.current = true;
        patchDownside(patch);
      }
      kiDroppedKg.current = false;
    }
  }

  function handleRun() {
    runPricing({ page: 'participation', product: pricingSpec, market, underlyingName, solve, greeks });
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
            // Templates are one-shot ACTIONS, not persistent states. Clicking
            // applies the preset config immediately, but the button never
            // shows a "selected" state afterward. The user is free to edit
            // any field after applying, without the button lying about it.
            <button key={p} type="button" className="btn btn-sm" onClick={() => applyPreset(p)}>
              {PARTICIPATION_PRESET_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      <Card title="General Terms">
        <NumericField
          label="Notional"
          value={spec.notional}
          step={10000}
          suffix={market.currency}
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
          disabled={!kiOn}
          title={!kiOn ? 'Bonus needs a KI barrier to apply. Enable KI Barrier below to activate it.' : undefined}
          solved={fieldSolved('bonusLevel')}
          solveChip={kiOn}
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
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <div className="field-label">
            <span>Features</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className={`btn btn-sm ${kiOn ? 'btn-active' : ''}`} onClick={toggleKI}>
              KI Barrier
            </button>
            <button type="button" className={`btn btn-sm ${psOn ? 'btn-active' : ''}`} onClick={togglePutSpread}>
              Put Spread
            </button>
            <button
              type="button"
              className={`btn btn-sm ${twOn ? 'btn-active' : ''}`}
              onClick={toggleTwinWin}
              title={!kiOn ? 'Enabling Twin Win will auto-enable a KI barrier' : undefined}
            >
              Twin Win
            </button>
            <button type="button" className={`btn btn-sm ${kgOn ? 'btn-active' : ''}`} onClick={toggleKG}>
              KG
            </button>
          </div>
        </div>
        {kiOn && (
          <>
            <div className="field">
              <div className="field-label">
                <span>Monitoring</span>
              </div>
              <Segmented<BarrierMonitoring>
                value={spec.downside.barrierType}
                options={[
                  { value: 'european', label: 'European' },
                  { value: 'american', label: 'American' },
                ]}
                onChange={(v) => patchDownside({ barrierType: v })}
              />
            </div>
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
          </>
        )}
        {psOn && spec.downside.putSpread && (
          <NumericField
            label="Lower strike"
            value={spec.downside.putSpread.lowerStrikePct}
            step={1}
            suffix="%"
            onChange={(v) => patchDownside({ putSpread: { lowerStrikePct: v } })}
            error={validation.errors.lowerStrikePct}
          />
        )}
        {twOn && (
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
        {kgOn && (
          <NumericField
            label="Protection"
            value={spec.protectionPct}
            step={1}
            suffix="%"
            onChange={(v) => patchSpec({ protectionPct: v })}
          />
        )}
        {kgKiNeverBites && (
          <span className="text-muted" style={{ fontSize: 11 }}>
            With 100% protection the KI downside never bites — combine with twin-win (TWKG) or drop one.
          </span>
        )}
      </Card>

      {Object.keys(basketValidation.errors).length > 0 && (
        <div style={{ gridColumn: '1 / -1' }} className="status-line error">
          {Object.values(basketValidation.errors).join(' ')}
        </div>
      )}

      <PricingFooter
        page="participation"
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
