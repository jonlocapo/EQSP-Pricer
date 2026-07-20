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
  hint,
  solveChip,
  solveActive,
  onSolveClick,
}: NumericFieldProps) {
  const readOnly = solved || disabled;
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
          {badge && !solved && !onBadgeClick && <span className="solved-badge">{badge}</span>}
          {solved && !solveChip && <span className="solved-badge">SOLVED</span>}
        </span>
      </div>
      <div className={`numeric-field ${solved ? 'solved' : ''}`}>
        <input
          className={`input ${error ? 'invalid' : ''}`}
          type="number"
          value={Number.isFinite(value) ? value : ''}
          step={step}
          min={min}
          max={max}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.valueAsNumber)}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
      {error && <span className="field-hint">{error}</span>}
      {!error && hint && <span className="text-muted" style={{ fontSize: 11 }}>{hint}</span>}
    </div>
  );
}
