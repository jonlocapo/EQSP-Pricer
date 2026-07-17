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

interface TenorFieldProps {
  years: number;
  onChange: (years: number) => void;
  error?: string;
}

export function TenorField({ years, onChange, error }: TenorFieldProps) {
  const matchedPreset = TENOR_PRESETS.find((t) => t.years === years);
  const [customMode, setCustomMode] = useState(!matchedPreset);

  const segValue = customMode || !matchedPreset ? 'custom' : matchedPreset.label;

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
        <NumericField
          label="Custom years"
          value={years}
          step={0.25}
          suffix="y"
          onChange={onChange}
          error={error}
        />
      )}
    </div>
  );
}
