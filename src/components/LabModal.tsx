import { useMemo, useRef, useState } from 'react';
import type { LabBlock } from '../model/lab';
import { LAB_PRESETS, makeBlock } from '../model/lab';
import type { LabSpec } from '../model/lab';
import type { BarrierMonitoring, Frequency } from '../model/product';
import type { PriceRequest, PriceResult } from '../model/request';
import { DEFAULT_MC } from '../model/request';
import { pricerClient } from '../worker/client';
import { useMarketStore } from '../state/marketStore';
import { NumericField } from './NumericField';
import { SelectField } from './SelectField';
import { Segmented } from './Segmented';
import { Toggle } from './Toggle';

interface LabModalProps {
  onClose: () => void;
}

const BLOCK_LABELS: Record<LabBlock['t'], string> = {
  coupon: 'Coupon',
  autocall: 'Autocall',
  shortPut: 'Short put',
  upside: 'Upside',
  bonus: 'Bonus',
  protection: 'Protection',
};

const BLOCK_GLYPHS: Record<LabBlock['t'], string> = {
  coupon: '%',
  autocall: '⤴',
  shortPut: '▼',
  upside: '▲',
  bonus: '+',
  protection: '⛨',
};

const PALETTE: LabBlock['t'][] = ['coupon', 'autocall', 'shortPut', 'upside', 'bonus', 'protection'];

const FREQ_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'semiannual', label: 'Semiannual' },
  { value: 'annual', label: 'Annual' },
];

const BARRIER_OPTIONS: { value: BarrierMonitoring; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'european', label: 'European' },
  { value: 'american', label: 'American' },
];

function blockSummary(b: LabBlock): string {
  switch (b.t) {
    case 'coupon':
      return `${b.ratePaPct}% p.a. ${b.frequency}${b.barrierPct === null ? ', unconditional' : `, barrier ${b.barrierPct}%`}${b.memory ? ', memory' : ''}`;
    case 'autocall':
      return `${b.frequency} from period ${b.fromPeriod}, barrier ${b.barrierPct}%${b.stepDownPct ? `, step-down ${b.stepDownPct}%` : ''}`;
    case 'shortPut':
      return `strike ${b.strikePct}%, ${b.leveragePct}% leverage, ${b.barrierType} KI`;
    case 'upside':
      return `strike ${b.strikePct}%, ${b.participationPct}% participation${b.capPct === null ? '' : `, cap ${b.capPct}%`}`;
    case 'bonus':
      return `+${b.bonusPct}%${b.barrierPct === null ? ', unconditional' : ` if perf >= ${b.barrierPct}%`}`;
    case 'protection':
      return `floor ${b.floorPct}%`;
  }
}

/** One canvas block's own field editor. Every numeric/select/toggle input
 * reuses the shared field components — see App.tsx's other pages — instead
 * of raw <input> elements, so the Lab matches the rest of the app's look. */
function BlockFields({ block, onChange }: { block: LabBlock; onChange: (next: LabBlock) => void }) {
  switch (block.t) {
    case 'coupon':
      return (
        <div className="field-group">
          <div className="field-row">
            <SelectField label="Frequency" value={block.frequency} options={FREQ_OPTIONS} onChange={(v) => onChange({ ...block, frequency: v as Frequency })} />
            <NumericField label="Rate" suffix="% p.a." step={0.5} value={block.ratePaPct} onChange={(v) => onChange({ ...block, ratePaPct: v })} />
          </div>
          <div className="field-row">
            <Toggle
              label="Barrier-conditional"
              checked={block.barrierPct !== null}
              onChange={(on) => onChange({ ...block, barrierPct: on ? (block.barrierPct ?? 60) : null })}
            />
            {block.barrierPct !== null && (
              <NumericField label="Barrier" suffix="%" step={1} value={block.barrierPct} onChange={(v) => onChange({ ...block, barrierPct: v })} />
            )}
          </div>
          {block.barrierPct !== null && <Toggle label="Memory (phoenix)" checked={block.memory} onChange={(v) => onChange({ ...block, memory: v })} />}
        </div>
      );
    case 'autocall':
      return (
        <div className="field-group">
          <div className="field-row">
            <SelectField label="Frequency" value={block.frequency} options={FREQ_OPTIONS} onChange={(v) => onChange({ ...block, frequency: v as Frequency })} />
            <NumericField label="From period" step={1} min={1} value={block.fromPeriod} onChange={(v) => onChange({ ...block, fromPeriod: v })} />
          </div>
          <div className="field-row">
            <NumericField label="Barrier" suffix="%" step={1} value={block.barrierPct} onChange={(v) => onChange({ ...block, barrierPct: v })} />
            <NumericField label="Step-down" suffix="% / obs" step={0.5} value={block.stepDownPct} onChange={(v) => onChange({ ...block, stepDownPct: v })} />
          </div>
          <NumericField label="Snowball coupon" suffix="% p.a." step={0.5} value={block.snowballPaPct} onChange={(v) => onChange({ ...block, snowballPaPct: v })} />
        </div>
      );
    case 'shortPut':
      return (
        <div className="field-group">
          <div className="field-row">
            <NumericField label="Strike" suffix="%" step={1} value={block.strikePct} onChange={(v) => onChange({ ...block, strikePct: v })} />
            <NumericField label="Leverage" suffix="%" step={5} value={block.leveragePct} onChange={(v) => onChange({ ...block, leveragePct: v })} />
          </div>
          <div className="field">
            <div className="field-label">
              <span>Knock-in monitoring</span>
            </div>
            <Segmented value={block.barrierType} options={BARRIER_OPTIONS} onChange={(v) => onChange({ ...block, barrierType: v })} />
          </div>
          {block.barrierType !== 'none' && (
            <NumericField label="KI barrier" suffix="%" step={1} value={block.kiBarrierPct} onChange={(v) => onChange({ ...block, kiBarrierPct: v })} />
          )}
        </div>
      );
    case 'upside':
      return (
        <div className="field-group">
          <div className="field-row">
            <NumericField label="Strike" suffix="%" step={1} value={block.strikePct} onChange={(v) => onChange({ ...block, strikePct: v })} />
            <NumericField label="Participation" suffix="%" step={5} value={block.participationPct} onChange={(v) => onChange({ ...block, participationPct: v })} />
          </div>
          <div className="field-row">
            <Toggle
              label="Capped"
              checked={block.capPct !== null}
              onChange={(on) => onChange({ ...block, capPct: on ? (block.capPct ?? 130) : null })}
            />
            {block.capPct !== null && <NumericField label="Cap" suffix="%" step={1} value={block.capPct} onChange={(v) => onChange({ ...block, capPct: v })} />}
          </div>
        </div>
      );
    case 'bonus':
      return (
        <div className="field-group">
          <NumericField label="Bonus" suffix="% above par" step={1} value={block.bonusPct} onChange={(v) => onChange({ ...block, bonusPct: v })} />
          <div className="field-row">
            <Toggle
              label="Barrier-conditional"
              checked={block.barrierPct !== null}
              onChange={(on) => onChange({ ...block, barrierPct: on ? (block.barrierPct ?? 100) : null })}
            />
            {block.barrierPct !== null && (
              <NumericField label="Barrier" suffix="%" step={1} value={block.barrierPct} onChange={(v) => onChange({ ...block, barrierPct: v })} />
            )}
          </div>
        </div>
      );
    case 'protection':
      return (
        <div className="field-group">
          <NumericField label="Floor" suffix="% of notional" step={1} value={block.floorPct} onChange={(v) => onChange({ ...block, floorPct: v })} />
        </div>
      );
  }
}

export function LabModal({ onClose }: LabModalProps) {
  const market = useMarketStore((s) => s.market);
  const [spec, setSpec] = useState<LabSpec>(() => LAB_PRESETS[0].build());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const draggedPaletteType = useRef<LabBlock['t'] | null>(null);
  const draggedCanvasIndex = useRef<number | null>(null);

  const [result, setResult] = useState<PriceResult | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const runIdRef = useRef(0);

  function addBlock(t: LabBlock['t']) {
    const block = makeBlock(t);
    setSpec((s) => ({ ...s, blocks: [...s.blocks, block] }));
    setExpandedId(block.id);
  }

  function updateBlock(id: string, next: LabBlock) {
    setSpec((s) => ({ ...s, blocks: s.blocks.map((b) => (b.id === id ? next : b)) }));
  }

  function removeBlock(id: string) {
    setSpec((s) => ({ ...s, blocks: s.blocks.filter((b) => b.id !== id) }));
  }

  function moveBlock(from: number, to: number) {
    setSpec((s) => {
      const blocks = s.blocks.slice();
      const [moved] = blocks.splice(from, 1);
      blocks.splice(to, 0, moved);
      return { ...s, blocks };
    });
  }

  function reorderTo(index: number) {
    if (draggedCanvasIndex.current !== null && draggedCanvasIndex.current !== index) {
      moveBlock(draggedCanvasIndex.current, index);
      draggedCanvasIndex.current = index;
    }
    setDragOverIndex(null);
  }

  const canPrice = spec.blocks.length > 0;

  async function priceLab() {
    if (!canPrice) return;
    const myRun = ++runIdRef.current;
    setPricing(true);
    setPriceError(null);
    try {
      const req: PriceRequest = {
        id: crypto.randomUUID(),
        product: spec,
        market,
        mc: DEFAULT_MC,
        solve: { kind: 'none' },
        greeks: false,
      };
      const r = await pricerClient.price(req, () => {});
      if (myRun === runIdRef.current) setResult(r);
    } catch (err) {
      if (myRun === runIdRef.current) {
        setPriceError(err instanceof Error ? err.message : 'Pricing failed.');
        setResult(null);
      }
    } finally {
      if (myRun === runIdRef.current) setPricing(false);
    }
  }

  const applyPreset = useMemo(
    () => (name: string) => {
      const preset = LAB_PRESETS.find((p) => p.name === name);
      if (!preset) return;
      setSpec(preset.build());
      setResult(null);
      setPriceError(null);
      setExpandedId(null);
    },
    [],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal lab-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>🧪 Contract Lab</h2>
          <button className="btn btn-sm" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body lab-body">
          <div className="lab-guide">
            A block is one leg of a structured product's payoff: a coupon, an autocall, a short put, upside
            participation, a bonus, or a protection floor. Drag blocks from the palette onto the canvas, or use their
            add buttons, to assemble a contract. Set each block's terms, then price the result.
          </div>

          <div className="lab-toolbar">
            <SelectField
              label="Start from a preset"
              value=""
              options={[{ value: '', label: 'Choose a preset…', disabled: true }, ...LAB_PRESETS.map((p) => ({ value: p.name, label: p.name }))]}
              onChange={applyPreset}
            />
          </div>

          <div className="lab-layout">
            <div className="lab-palette">
              <div className="card-title">Blocks</div>
              {PALETTE.map((t) => (
                <div
                  key={t}
                  className="lab-palette-item"
                  draggable
                  onDragStart={() => {
                    draggedPaletteType.current = t;
                    draggedCanvasIndex.current = null;
                  }}
                  onDragEnd={() => {
                    draggedPaletteType.current = null;
                  }}
                >
                  <span className="lab-block-glyph">{BLOCK_GLYPHS[t]}</span>
                  <span>{BLOCK_LABELS[t]}</span>
                  <button type="button" className="btn btn-sm lab-add-btn" onClick={() => addBlock(t)} aria-label={`Add ${BLOCK_LABELS[t]} block`}>
                    +
                  </button>
                </div>
              ))}
            </div>

            <div
              className="lab-canvas"
              onDragOver={(e) => {
                if (draggedPaletteType.current) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedPaletteType.current) {
                  addBlock(draggedPaletteType.current);
                  draggedPaletteType.current = null;
                }
              }}
            >
              <div className="card-title">Contract ({spec.blocks.length} block{spec.blocks.length === 1 ? '' : 's'})</div>
              {spec.blocks.length === 0 && <div className="history-empty">Drag a block here, or use its + button.</div>}
              {spec.blocks.map((b, i) => (
                <div
                  key={b.id}
                  className={`lab-canvas-block ${dragOverIndex === i ? 'drag-over' : ''}`}
                  draggable
                  onDragStart={() => {
                    draggedCanvasIndex.current = i;
                    draggedPaletteType.current = null;
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverIndex(i);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    reorderTo(i);
                  }}
                  onDragEnd={() => {
                    draggedCanvasIndex.current = null;
                    setDragOverIndex(null);
                  }}
                >
                  <div className="lab-canvas-block-header" onClick={() => setExpandedId(expandedId === b.id ? null : b.id)}>
                    <span className="lab-block-glyph">{BLOCK_GLYPHS[b.t]}</span>
                    <div className="lab-canvas-block-title">
                      <b>{BLOCK_LABELS[b.t]}</b>
                      <span className="text-muted" style={{ fontSize: 11 }}>
                        {blockSummary(b)}
                      </span>
                    </div>
                    <div className="lab-canvas-block-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={i === 0}
                        aria-label={`Move ${BLOCK_LABELS[b.t]} up`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (i > 0) moveBlock(i, i - 1);
                        }}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={i === spec.blocks.length - 1}
                        aria-label={`Move ${BLOCK_LABELS[b.t]} down`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (i < spec.blocks.length - 1) moveBlock(i, i + 1);
                        }}
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        aria-label={`Remove ${BLOCK_LABELS[b.t]} block`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeBlock(b.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  {expandedId === b.id && (
                    <div className="lab-canvas-block-body">
                      <BlockFields block={b} onChange={(next) => updateBlock(b.id, next)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="lab-price-bar">
            <div className="field-row">
              <NumericField label="Tenor" suffix="y" step={0.25} min={0.25} max={10} value={spec.tenorYears} onChange={(v) => setSpec((s) => ({ ...s, tenorYears: v }))} />
              <NumericField label="Notional" step={100_000} value={spec.notional} onChange={(v) => setSpec((s) => ({ ...s, notional: v }))} />
            </div>
            <button className="btn btn-primary" type="button" disabled={!canPrice || pricing} onClick={() => void priceLab()}>
              {pricing ? 'Pricing…' : 'Price contract'}
            </button>
            {priceError && <span className="field-hint">{priceError}</span>}
            {result && !priceError && (
              <div className="lab-result">
                <b>{result.pvPct.toFixed(3)}%</b>
                <span className="text-muted" style={{ fontSize: 11 }}>
                  ± {(1.96 * result.stderrPct).toFixed(3)}% (95% CI) · {result.elapsedMs}ms
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
