import { describe, expect, it, beforeEach } from 'vitest';
import { useResultsStore } from '../src/state/resultsStore';
import type { PriceResult } from '../src/model/request';

function makeResult(overrides: Partial<PriceResult> = {}): PriceResult {
  return {
    id: 'r1',
    pvPct: 98.5,
    pvCcy: 985_000,
    stderrPct: 0.05,
    ci95Pct: [98.4, 98.6],
    diagnostics: {},
    elapsedMs: 120,
    ...overrides,
  };
}

describe('resultsStore soft live-unsolvable state', () => {
  beforeEach(() => {
    useResultsStore.setState({
      runId: null,
      running: false,
      progress: null,
      result: null,
      error: null,
      liveUnsolvable: null,
      expanded: false,
    });
  });

  it('failLiveRun sets liveUnsolvable but keeps the last good result and does not touch error', () => {
    const store = useResultsStore.getState();
    const result = makeResult();
    store.finishRun(result);

    store.failLiveRun('No solution at current terms.');

    const state = useResultsStore.getState();
    expect(state.liveUnsolvable).toBe('No solution at current terms.');
    // The last good value must survive a soft live failure untouched.
    expect(state.result).toBe(result);
    expect(state.error).toBeNull();
    expect(state.running).toBe(false);
  });

  it('liveUnsolvable is distinct from failRun — an explicit failure uses error, not liveUnsolvable', () => {
    const store = useResultsStore.getState();
    store.failRun('Pricing failed: boom');

    const state = useResultsStore.getState();
    expect(state.error).toBe('Pricing failed: boom');
    expect(state.liveUnsolvable).toBeNull();
  });

  it('a subsequent successful run auto-clears liveUnsolvable', () => {
    const store = useResultsStore.getState();
    store.finishRun(makeResult());
    store.failLiveRun('No solution at current terms.');
    expect(useResultsStore.getState().liveUnsolvable).not.toBeNull();

    const nextResult = makeResult({ id: 'r2', pvPct: 99.1 });
    store.finishRun(nextResult);

    const state = useResultsStore.getState();
    expect(state.liveUnsolvable).toBeNull();
    expect(state.result).toBe(nextResult);
  });

  it('an explicit failRun also clears any stale liveUnsolvable hint', () => {
    const store = useResultsStore.getState();
    store.finishRun(makeResult());
    store.failLiveRun('No solution at current terms.');

    store.failRun('Unexpected engine error');

    const state = useResultsStore.getState();
    expect(state.error).toBe('Unexpected engine error');
    expect(state.liveUnsolvable).toBeNull();
  });
});
