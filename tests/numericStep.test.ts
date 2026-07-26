import { describe, expect, it } from 'vitest';
import { decimalsOf, nextStepValue } from '../src/components/numericStep';

/**
 * The stepper must SNAP to the next multiple of the increment, not add the
 * increment blindly. A solve leaves values like 3.0456, and a blind add keeps
 * that tail forever. Both the ▲▼ buttons and the keyboard arrows run through
 * nextStepValue, so these cases pin the behaviour for both.
 */

describe('decimalsOf', () => {
  it('reports the decimals a step implies', () => {
    expect(decimalsOf(5)).toBe(0);
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(2.5)).toBe(1);
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.25)).toBe(2);
    expect(decimalsOf(0.01)).toBe(2);
  });
});

describe('nextStepValue', () => {
  it('snaps up to the next multiple from an off-grid value', () => {
    expect(nextStepValue(98.5, 5, 1)).toBe(100);
  });

  it('snaps down to the previous multiple from an off-grid value', () => {
    expect(nextStepValue(62, 5, -1)).toBe(60);
  });

  it('moves a full increment when already on a multiple', () => {
    expect(nextStepValue(100, 5, 1)).toBe(105);
    expect(nextStepValue(100, 5, -1)).toBe(95);
    expect(nextStepValue(0.5, 0.25, 1)).toBe(0.75);
  });

  it('treats a value a floating-point hair off a multiple as on it', () => {
    // 0.1 + 0.2 is 0.30000000000000004, so dividing by a 0.1 step gives
    // 3.0000000000000004 units. Without the epsilon guard, stepping up would
    // ceil to 4 units and return 0.4 twice in a row, and stepping down would
    // floor to 3 units and return 0.3, leaving the value stuck where it
    // already was. The guard must treat it as sitting on 3 units.
    const hair = 0.1 + 0.2;
    expect(hair).not.toBe(0.3);
    expect(nextStepValue(hair, 0.1, 1)).toBe(0.4);
    expect(nextStepValue(hair, 0.1, -1)).toBe(0.2);
  });

  it('keeps the decimals the step implies, with no floating-point tail', () => {
    expect(nextStepValue(3.0456, 0.1, 1)).toBe(3.1);
    expect(nextStepValue(3.0456, 0.1, -1)).toBe(3);
    expect(nextStepValue(98.6, 0.1, 1)).toBe(98.7);
  });

  it('handles negative values symmetrically', () => {
    expect(nextStepValue(-2.5, 1, 1)).toBe(-2);
    expect(nextStepValue(-2.5, 1, -1)).toBe(-3);
    expect(nextStepValue(-3, 1, -1)).toBe(-4);
  });

  it('steps from zero, and treats a non-finite value as zero', () => {
    expect(nextStepValue(0, 5, 1)).toBe(5);
    expect(nextStepValue(NaN, 5, 1)).toBe(5);
    expect(nextStepValue(NaN, 5, -1)).toBe(-5);
  });

  it('works with a large step, as the notional field uses', () => {
    expect(nextStepValue(1_234_567, 100_000, 1)).toBe(1_300_000);
    expect(nextStepValue(1_234_567, 100_000, -1)).toBe(1_200_000);
    expect(nextStepValue(1_000_000, 100_000, 1)).toBe(1_100_000);
  });
});
