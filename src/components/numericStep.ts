/**
 * The stepping maths behind NumericField's arrows. Kept in its own module, with
 * no React, so tests can drive it directly.
 */

/** Decimal places implied by a step, so stepping 0.1 from 98.5 gives 98.6,
 * not 98.60000000000001. */
export function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * The next value in the direction of travel, snapped to a multiple of `step`.
 *
 * A value left by a solve is rarely on a round increment (3.0456 with a 0.1
 * step). Adding the increment blindly keeps that untidy tail forever (3.1456,
 * 3.2456, and so on). Snapping to the next multiple gives 3.1, then 3.2, so the
 * first press also tidies the number. A value already on a multiple moves one
 * full increment.
 */
export function nextStepValue(value: number, step: number, direction: 1 | -1): number {
  const base = Number.isFinite(value) ? value : 0;
  const units = base / step;
  // Guard against a value that is only a floating-point hair off a multiple
  // (0.1 * 30 !== 3 exactly): treat it as already on the multiple.
  const onMultiple = Math.abs(units - Math.round(units)) < 1e-9;
  const nextUnits = onMultiple
    ? Math.round(units) + direction
    : direction === 1
      ? Math.ceil(units)
      : Math.floor(units);
  return Number((nextUnits * step).toFixed(decimalsOf(step)));
}

/** Magnitude suffixes NumericField accepts, lower-cased. `bn` and `b` both
 * mean billion, matching how notionals get typed and quoted informally. */
const SUFFIX_MULTIPLIERS: Record<string, number> = {
  '': 1,
  k: 1e3,
  m: 1e6,
  b: 1e9,
  bn: 1e9,
};

/**
 * Parses a typed number that may carry a k/m/b/bn magnitude suffix and
 * thousands separators, e.g. "20k" -> 20000, "2.5m" -> 2_500_000,
 * "1,000,000" -> 1_000_000, "1 000 000" -> 1_000_000. Case-insensitive, and
 * tolerant of whitespace around the suffix ("20 k").
 *
 * Returns `undefined` for anything that does not parse cleanly, never
 * `NaN`, so a caller can leave the field's current value untouched on a bad
 * entry, exactly like a plain unparseable number does today.
 *
 * Call this only on COMMIT (blur or Enter), never on every keystroke:
 * parsing mid-typing would fight the user while they are still typing "2",
 * then "20", then "20k".
 */
export function parseNumericInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  // Mantissa (digits, an optional decimal point, and group separators),
  // then an optional space, then an optional letter suffix.
  const m = /^(-?[\d,\s]+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(trimmed);
  if (!m) return undefined;

  // A comma is a group separator only when followed by exactly three
  // digits, e.g. the two commas in "1,000,000". A comma used as a DECIMAL
  // separator is ambiguous, so it is never stripped here: "1,5" keeps its
  // comma, fails Number() below, and the caller leaves the field alone.
  const mantissa = m[1].replace(/\s+/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
  const value = Number(mantissa);
  if (!Number.isFinite(value)) return undefined;

  const multiplier = SUFFIX_MULTIPLIERS[m[2].toLowerCase()];
  if (multiplier === undefined) return undefined;

  const result = value * multiplier;
  return Number.isFinite(result) ? result : undefined;
}
