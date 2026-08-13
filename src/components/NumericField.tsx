import { useEffect, useRef, useState, type ReactNode } from 'react';
import { noteEditSource } from '../state/editSource';
import { nextStepValue, parseNumericInput } from './numericStep';

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
   * When set, `badge` is rendered as a clickable toggle button, instead of
   * a passive label, for example the AUTO leverage toggle. `badgeOn`
   * controls its active or inactive visual state.
   */
  onBadgeClick?: () => void;
  badgeOn?: boolean;
  /** Styling for a passive, non-clickable, `badge`. Defaults to the accent
   * `solved-badge`. The market panel passes `manual-badge`, so its amber
   * "you have overridden fetched data" meaning survives. */
  badgeClassName?: string;
  /** Rendered immediately after the label text. Used for the fetch
   * information dot, which belongs to the label rather than to the badge
   * cluster on the right. */
  labelExtra?: ReactNode;
  hint?: string;
  /**
   * Renders a clickable "SOLVE" chip next to the label. This is the
   * per-field analogue of the AUTO toggle, used to pick this field as the
   * active solve target, with radio semantics across a page's fields.
   * Reuses the exact `.auto-toggle` chip styling; only the label text,
   * "SOLVE" versus "AUTO", differentiates it. Renders alongside the
   * `solved` dimming style. The chip itself is the indicator that this
   * field is the active solve target, so it stays visible and active even
   * while the field is dimmed and read-only.
   */
  solveChip?: boolean;
  solveActive?: boolean;
  onSolveClick?: () => void;
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
  labelExtra,
  hint,
  solveChip,
  solveActive,
  onSolveClick,
}: NumericFieldProps) {
  const readOnly = solved || disabled;

  // The raw text being typed, held locally, so a transient non-numeric state,
  // an empty field mid-retype, never propagates upward. Without this, an
  // input.valueAsNumber of NaN reaches the spec, and a live reprice fires on
  // it. null means "not editing, show the committed value".
  const [draft, setDraft] = useState<string | null>(null);
  // A committed value arriving from outside — a solve writing its result
  // back, a preset, a live market fetch — supersedes whatever was being
  // typed.
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
    // An empty, or otherwise unparseable, field is a normal intermediate
    // state while retyping. Keep it on screen, but do not publish it. This
    // stays a PLAIN number check, not the shorthand parser: trying "20k"
    // shorthand mid-keystroke would fight the user as they type "2", then
    // "20", then "20k" — see commitDraft, which runs the shorthand parser
    // once, on blur or Enter, instead.
    if (raw.trim() === '') return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) commit(parsed, 'type');
  }

  /** Runs once the user finishes editing (blur or Enter). Re-parses the
   * whole draft with the shorthand parser, so "20k" and "1,000,000" commit
   * correctly even though the per-keystroke plain-number check above never
   * accepted them. A draft that still does not parse leaves the field at
   * its last committed value, exactly like today's unparseable-input case. */
  function commitDraft(): void {
    if (draft === null) return;
    const parsed = parseNumericInput(draft);
    if (parsed !== undefined) commit(parsed, 'type');
    setDraft(null);
  }

  /** Steps to the next multiple of `step`, not just `value ± step`. See
   * nextStepValue in ./numericStep for why. */
  function stepBy(direction: 1 | -1): void {
    setDraft(null);
    commit(nextStepValue(value, step, direction), 'step');
  }

  /**
   * Sends the keyboard Up and Down arrows through `stepBy`, so they behave
   * exactly like the ▲▼ buttons.
   *
   * Do not remove this. A native `<input type="number">` steps ITSELF on an
   * arrow key, and that native step is wrong twice over. It adds a raw
   * `value ± step` with no snapping to a multiple, and it reaches the app as an
   * ordinary `onChange`, indistinguishable from typing, so the edit gets the
   * long typing debounce instead of the short step debounce. `preventDefault`
   * is what suppresses the native step. Without it the value moves twice.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepBy(1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepBy(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft();
    }
  }

  const shown = draft !== null ? draft : Number.isFinite(value) ? String(value) : '';

  return (
    <div className="field" title={title}>
      <div className="field-label">
        <span>
          {label}
          {labelExtra}
        </span>
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
          // Plain text, not type="number": a native number input rejects
          // letter keystrokes outright, which would make the "20k" / "2m"
          // shorthand impossible to even type. inputMode still gets mobile
          // browsers to show a numeric keyboard.
          type="text"
          inputMode="decimal"
          // Reserve room for the stepper column PLUS this field's own suffix.
          // A single fixed padding cannot serve both "%" and "EUR"; a long
          // suffix collided with a long value (1000000EUR).
          style={{ paddingRight: suffix ? Math.max(46, Math.ceil(30 + suffix.length * 9)) : 26 }}
          value={shown}
          disabled={readOnly}
          onChange={(e) => handleType(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commitDraft}
        />
        {suffix && <span className="suffix">{suffix}</span>}
        {/* Own stepper buttons, rather than the browser's native spin buttons.
         * The native ones only appear on hover or focus, are a tiny hit
         * target, and, decisively, their input events are indistinguishable
         * from typing. So they cannot get the shorter step-style debounce
         * that makes arrow bursts feel instant. Native spinners are hidden
         * in CSS, so there is only ever one set of arrows. */}
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
