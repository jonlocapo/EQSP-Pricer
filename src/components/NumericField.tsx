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
}: NumericFieldProps) {
  const readOnly = solved || disabled;
  return (
    <div className="field" title={title}>
      <div className="field-label">
        <span>{label}</span>
        {solved && <span className="solved-badge">SOLVED</span>}
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
    </div>
  );
}
