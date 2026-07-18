import { useState } from 'react';
import { Segmented } from './Segmented';
import { NumericField } from './NumericField';

const TENOR_PRESETS: { label: string; years: number }[] = [
  { label: '3M', years: 0.25 },
  { label: '6M', years: 0.5 },
  { label: '1Y', years: 1 },
  { label: '18M', years: 1.5 },
  { label: '2Y', years: 2 },
  { label: '3Y', years: 3 },
  { label: '5Y', years: 5 },
];

type TenorUnit = 'months' | 'years';

interface TenorFieldProps {
  years: number;
  onChange: (years: number) => void;
  error?: string;
}

export function TenorField({ years, onChange, error }: TenorFieldProps) {
  const matchedPreset = TENOR_PRESETS.find((t) => t.years === years);
  const [customMode, setCustomMode] = useState(!matchedPreset);
  const [unit, setUnit] = useState<TenorUnit>('months');

  const segValue = customMode || !matchedPreset ? 'custom' : matchedPreset.label;
  const customValue = unit === 'months' ? years * 12 : years;

  return (
    <div className="field">
      <div className="field-label">
        <span>Tenor</span>
      </div>
      <Segmented
        value={segValue}
        options={[...TENOR_PRESETS.map((t) => ({ value: t.label, label: t.label })), { value: 'custom', label: 'Custom' }]}
        onChange={(v) => {
          if (v === 'custom') {
            setCustomMode(true);
            return;
          }
          const preset = TENOR_PRESETS.find((t) => t.label === v);
          if (preset) {
            setCustomMode(false);
            onChange(preset.years);
          }
        }}
      />
      {(customMode || !matchedPreset) && (
        <div className="field-row">
          <NumericField
            label="Custom tenor"
            value={customValue}
            step={unit === 'months' ? 1 : 0.25}
            suffix={unit === 'months' ? 'm' : 'y'}
            onChange={(v) => onChange(unit === 'months' ? v / 12 : v)}
            error={error}
          />
          <div className="field">
            <div className="field-label">
              <span>Unit</span>
            </div>
            <Segmented<TenorUnit>
              value={unit}
              options={[
                { value: 'months', label: 'Months' },
                { value: 'years', label: 'Years' },
              ]}
              onChange={setUnit}
            />
          </div>
        </div>
      )}
    </div>
  );
}
