import { describe, expect, it } from 'vitest';
import { gridParamsFor } from '../src/model/paramRegistry';
import { DEFAULT_COUPON_SPEC, DEFAULT_PARTICIPATION, DEFAULT_ACCUMULATOR } from '../src/state/tradeStore';
import type { ProductSpec } from '../src/model/product';

const KINDS: ProductSpec['kind'][] = ['coupon', 'participation', 'accumulator', 'lab'];

const BASE_SPECS: Record<'coupon' | 'participation' | 'accumulator', ProductSpec> = {
  coupon: DEFAULT_COUPON_SPEC,
  participation: DEFAULT_PARTICIPATION,
  accumulator: DEFAULT_ACCUMULATOR,
};

describe('gridParamsFor', () => {
  it('returns an empty list for the Lab, which is out of scope', () => {
    expect(gridParamsFor('lab')).toEqual([]);
  });

  it('every family list is non-empty with no duplicate keys', () => {
    for (const kind of ['coupon', 'participation', 'accumulator'] as const) {
      const params = gridParamsFor(kind);
      expect(params.length).toBeGreaterThan(0);
      const keys = params.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  for (const kind of ['coupon', 'participation', 'accumulator'] as const) {
    describe(`${kind} descriptors`, () => {
      const base = BASE_SPECS[kind];
      for (const param of gridParamsFor(kind)) {
        it(`'${param.key}': read(write(spec, v)) round trips`, () => {
          const testValue = param.read(base) + param.step * 3;
          const next = param.write(base, testValue);
          expect(param.read(next)).toBeCloseTo(testValue, 6);
        });

        it(`'${param.key}': write never mutates its input`, () => {
          const before = JSON.parse(JSON.stringify(base));
          param.write(base, param.read(base) + param.step);
          expect(base).toEqual(before);
        });
      }
    });
  }

  it('KINDS constant covers every ProductSpec kind (exhaustiveness sanity)', () => {
    expect(KINDS).toEqual(['coupon', 'participation', 'accumulator', 'lab']);
  });
});
