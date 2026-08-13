import { describe, expect, it } from 'vitest';
import { fmtMs, tooltipFor, worstKind, type FetchLine } from '../src/components/fetchFormat';

/**
 * Every fetch outcome used to stack into one run-on paragraph under the Fetch
 * button. Each line now carries the field it describes, so the panel can put
 * it on that field's information dot. These pin the routing.
 */

const lines: FetchLine[] = [
  { kind: 'ok', msg: 'Spot 512.4 · Yahoo · 380ms', field: 'spot' },
  { kind: 'ok', msg: 'Rate 3.620% · ECB ESTR', field: 'rate' },
  { kind: 'info', msg: 'Rate curve: failed. Discounting stays flat.', field: 'rate' },
  { kind: 'err', msg: 'Vol: timed out', field: 'vol' },
  { kind: 'ok', msg: 'Correlation lifted 15 points', field: 'correlation' },
  { kind: 'info', msg: '15 requests · total 6.2s', field: 'run' },
  { kind: 'ok', msg: 'a line nobody tagged' },
];

describe('a fetch line reaches the field it describes', () => {
  it('collects every line for one field, in order, one per row', () => {
    expect(tooltipFor(lines, 'rate')).toBe(
      'Rate 3.620% · ECB ESTR\nRate curve: failed. Discounting stays flat.',
    );
    expect(tooltipFor(lines, 'spot')).toBe('Spot 512.4 · Yahoo · 380ms');
  });

  it('reports nothing for a field nobody wrote about, so its dot stays off', () => {
    expect(tooltipFor(lines, 'dividend')).toBeUndefined();
    expect(tooltipFor([], 'spot')).toBeUndefined();
    expect(worstKind(lines, 'dividend')).toBeUndefined();
  });

  it('leaves an untagged line out of every field', () => {
    const everyField = (['spot', 'rate', 'vol', 'dividend', 'correlation', 'quanto', 'run'] as const)
      .map((f) => tooltipFor(lines, f) ?? '')
      .join('\n');
    expect(everyField).not.toContain('a line nobody tagged');
  });
});

describe('the dot takes the colour of the worst thing that happened', () => {
  it('an error outranks an info, which outranks a success', () => {
    // 'rate' holds one ok and one info: the info wins.
    expect(worstKind(lines, 'rate')).toBe('info');
    expect(worstKind(lines, 'vol')).toBe('err');
    expect(worstKind(lines, 'spot')).toBe('ok');
  });

  it('an error anywhere in a field wins, wherever it sits in the list', () => {
    const late: FetchLine[] = [
      { kind: 'ok', msg: 'first', field: 'spot' },
      { kind: 'info', msg: 'second', field: 'spot' },
      { kind: 'err', msg: 'third', field: 'spot' },
    ];
    expect(worstKind(late, 'spot')).toBe('err');
    expect(worstKind([...late].reverse(), 'spot')).toBe('err');
  });
});

describe('fmtMs', () => {
  it('uses milliseconds below a second and one decimal of seconds above', () => {
    expect(fmtMs(412)).toBe('412ms');
    expect(fmtMs(999)).toBe('999ms');
    expect(fmtMs(1000)).toBe('1.0s');
    expect(fmtMs(6234)).toBe('6.2s');
  });
});
