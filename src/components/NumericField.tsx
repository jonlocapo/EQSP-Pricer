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
  hint?: string;
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
  hint,
}: NumericFieldProps) {
  const readOnly = solved || disabled;
  return (
    <div className="field" title={title}>
      <div className="field-label">
        <span>{label}</span>
        <span style={{ display: 'flex', gap: 4 }}>
          {badge && !solved && <span className="solved-badge">{badge}</span>}
          {solved && <span className="solved-badge">SOLVED</span>}
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
