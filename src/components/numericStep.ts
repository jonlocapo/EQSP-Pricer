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
