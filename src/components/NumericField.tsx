import { useEffect, useRef, useState } from 'react';
import { noteEditSource } from '../state/editSource';

interface NumericFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  step?: number;
  min?: number;
  max?: number;
  error?: string;
  solved?: boolean;
  disabled?: boolean;
  title?: string;
  /** Extra badge rendered next to the label, e.g. an "AUTO" indicator. */
  badge?: string;
  /**
   * When set, `badge` is rendered as a clickable toggle button instead of a
   * passive label (e.g. the AUTO leverage toggle). `badgeOn` controls its
   * active/inactive visual state.
   */
  onBadgeClick?: () => void;
  badgeOn?: boolean;
  /** Styling for a passive (non-clickable) `badge`. Defaults to the accent
   * `solved-badge`; the market panel passes `manual-badge` so its amber
   * "you have overridden fetched data" meaning survives. */
  badgeClassName?: string;
  hint?: string;
  /**
   * Renders a clickable "SOLVE" chip next to the label — the per-field
   * analogue of the AUTO toggle, used to pick this field as the active solve
   * target (radio semantics across a page's fields). Reuses the exact
   * `.auto-toggle` chip styling; only the label text ("SOLVE" vs "AUTO")
   * differentiates it. Renders alongside the `solved` dimming style — the
   * chip itself is the indicator of "this field is the active solve target",
   * so it stays visible (and active) even while the field is dimmed/read-only.
   */
  solveChip?: boolean;
  solveActive?: boolean;
  onSolveClick?: () => void;
}

/** Decimal places implied by a step, so stepping 0.1 from 98.5 gives 98.6
 * rather than 98.60000000000001. */
function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function NumericField({
  label,
  value,
  onChange,
  suffix,
  step = 1,
  min,
  max,
  error,
  solved,
  disabled,
  title,
  badge,
  onBadgeClick,
  badgeOn,
  badgeClassName = 'solved-badge',
  hint,
  solveChip,
  solveActive,
  onSolveClick,
}: NumericFieldProps) {
  const readOnly = solved || disabled;

  // The raw text being typed, held locally so a transient non-numeric state
  // (an empty field mid-retype) never propagates upward. Without this, an
  // input.valueAsNumber of NaN reaches the spec and a live reprice fires on
  // it. null means "not editing — show the committed value".
  const [draft, setDraft] = useState<string | null>(null);
  // A committed value arriving from outside (a solve writing its result back,
  // a preset, a live market fetch) supersedes whatever was being typed.
  const lastValue = useRef(value);
  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setDraft(null);
    }
  }, [value]);

  function commit(next: number, source: 'type' | 'step') {
    if (!Number.isFinite(next)) return;
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));
    noteEditSource(source);
    lastValue.current = clamped;
    onChange(clamped);
  }

  function handleType(raw: string): void {
    setDraft(raw);
    // An empty (or otherwise unparseable) field is a normal intermediate
    // state while retyping — keep it on screen but don't publish it.
    if (raw.trim() === '') return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) commit(parsed, 'type');
  }

  function stepBy(direction: 1 | -1): void {
    const base = Number.isFinite(value) ? value : 0;
    const next = Number((base + direction * step).toFixed(decimalsOf(step)));
    setDraft(null);
    commit(next, 'step');
  }

  const shown = draft !== null ? draft : Number.isFinite(value) ? String(value) : '';

  return (
    <div className="field" title={title}>
      <div className="field-label">
        <span>{label}</span>
        <span style={{ display: 'flex', gap: 4 }}>
          {solveChip && (
            <button
              type="button"
              className={`auto-toggle ${solveActive ? 'on' : ''}`}
              onClick={onSolveClick}
              aria-pressed={solveActive}
            >
              SOLVE
            </button>
          )}
          {badge && !solved && onBadgeClick && (
            <button
              type="button"
              className={`auto-toggle ${badgeOn ? 'on' : ''}`}
              onClick={onBadgeClick}
              aria-pressed={badgeOn}
            >
              {badge}
            </button>
          )}
          {badge && !solved && !onBadgeClick && <span className={badgeClassName}>{badge}</span>}
          {solved && !solveChip && <span className="solved-badge">SOLVED</span>}
        </span>
      </div>
      <div className={`numeric-field ${solved ? 'solved' : ''}`}>
        <input
          className={`input ${error ? 'invalid' : ''}`}
          type="number"
          value={shown}
          step={step}
          min={min}
          max={max}
          disabled={readOnly}
          onChange={(e) => handleType(e.target.value)}
          onBlur={() => setDraft(null)}
        />
        {suffix && <span className="suffix">{suffix}</span>}
        {/* Own stepper buttons rather than the browser's native spin buttons:
         * the native ones only appear on hover/focus, are a tiny hit target,
         * and — decisively — their input events are indistinguishable from
         * typing, so they can't be given the shorter step-style debounce that
         * makes arrow bursts feel instant. Native spinners are hidden in CSS
         * so there's only ever one set of arrows. */}
        {!readOnly && (
          <span className="field-steppers">
            <button type="button" tabIndex={-1} aria-label={`Increase ${label}`} onClick={() => stepBy(1)}>
              ▲
            </button>
            <button type="button" tabIndex={-1} aria-label={`Decrease ${label}`} onClick={() => stepBy(-1)}>
              ▼
            </button>
          </span>
        )}
      </div>
      {error && <span className="field-hint">{error}</span>}
      {!error && hint && <span className="text-muted" style={{ fontSize: 11 }}>{hint}</span>}
    </div>
  );
}
