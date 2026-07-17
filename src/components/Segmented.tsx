interface Option<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  tooltip?: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
}

export function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          className={opt.value === value ? 'active' : ''}
          disabled={opt.disabled}
          title={opt.disabled ? opt.tooltip : undefined}
          onClick={() => !opt.disabled && onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
