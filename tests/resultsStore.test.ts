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
      runKind: null,
      runScope: null,
      running: false,
      pending: false,
      pendingScope: null,
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
    store.startRun('r1', 'explicit', 'full');
    store.finishRun('r1', result);

    store.startRun('r2', 'live', 'full');
    store.failLiveRun('r2', 'No solution at current terms.');

    const state = useResultsStore.getState();
    expect(state.liveUnsolvable).toBe('No solution at current terms.');
    // The last good value must survive a soft live failure untouched.
    expect(state.result).toBe(result);
    expect(state.error).toBeNull();
    expect(state.running).toBe(false);
  });

  it('liveUnsolvable is distinct from failRun — an explicit failure uses error, not liveUnsolvable', () => {
    const store = useResultsStore.getState();
    store.startRun('r1', 'explicit', 'full');
    store.failRun('r1', 'Pricing failed: boom');

    const state = useResultsStore.getState();
    expect(state.error).toBe('Pricing failed: boom');
    expect(state.liveUnsolvable).toBeNull();
  });

  it('a subsequent successful run auto-clears liveUnsolvable', () => {
    const store = useResultsStore.getState();
    store.startRun('r1', 'explicit', 'full');
    store.finishRun('r1', makeResult());
    store.startRun('r2', 'live', 'full');
    store.failLiveRun('r2', 'No solution at current terms.');
    expect(useResultsStore.getState().liveUnsolvable).not.toBeNull();

    const nextResult = makeResult({ id: 'r3', pvPct: 99.1 });
    store.startRun('r3', 'live', 'full');
    store.finishRun('r3', nextResult);

    const state = useResultsStore.getState();
    expect(state.liveUnsolvable).toBeNull();
    expect(state.result).toBe(nextResult);
  });

  it('an explicit failRun also clears any stale liveUnsolvable hint', () => {
    const store = useResultsStore.getState();
    store.startRun('r1', 'explicit', 'full');
    store.finishRun('r1', makeResult());
    store.startRun('r2', 'live', 'full');
    store.failLiveRun('r2', 'No solution at current terms.');

    store.startRun('r3', 'explicit', 'full');
    store.failRun('r3', 'Unexpected engine error');

    const state = useResultsStore.getState();
    expect(state.error).toBe('Unexpected engine error');
    expect(state.liveUnsolvable).toBeNull();
  });

  it('a stale run\'s late finishRun/failRun/cancelRun is a no-op once a newer run has taken over runId', () => {
    const store = useResultsStore.getState();
    const staleResult = makeResult({ id: 'stale', pvPct: 1 });
    const freshResult = makeResult({ id: 'fresh', pvPct: 2 });

    // Simulate: a live pass (stale) is in flight, then a newer run (fresh)
    // supersedes it (as runPricing's cancelPricing()/startRun sequencing
    // does) before the stale run's worker response finally arrives.
    store.startRun('stale', 'live', 'full');
    store.startRun('fresh', 'explicit', 'full');

    store.finishRun('stale', staleResult);
    expect(useResultsStore.getState().result).not.toBe(staleResult);

    store.failRun('stale', 'stale error');
    expect(useResultsStore.getState().error).toBeNull();

    store.cancelRun('stale');
    expect(useResultsStore.getState().running).toBe(true); // fresh run still "running"

    store.finishRun('fresh', freshResult);
    expect(useResultsStore.getState().result).toBe(freshResult);
  });

  it('every terminal transition clears the pending flag, so a dropped pass cannot stick the spinner', () => {
    const store = useResultsStore.getState();
    store.beginPending('full');

    // The gated-pass failure mode: beginPending raised the flag, but the
    // pass never started (runPricing's explicit-in-flight guard drops it),
    // so an unrelated run's terminal transition is what settles the state.
    store.startRun('other', 'explicit', 'full');
    store.failRun('other', 'boom');
    expect(useResultsStore.getState().pending).toBe(false);
    expect(useResultsStore.getState().pendingScope).toBeNull();

    store.beginPending('cached');
    store.startRun('r1', 'explicit', 'full');
    store.failRun('r1', 'boom');
    expect(useResultsStore.getState().pending).toBe(false);

    store.beginPending('cached');
    store.startRun('r2', 'live', 'full');
    store.failLiveRun('r2', 'No solution at current terms.');
    expect(useResultsStore.getState().pending).toBe(false);

    store.beginPending('full');
    store.startRun('r3', 'live', 'full');
    store.cancelRun('r3');
    expect(useResultsStore.getState().pending).toBe(false);

    store.beginPending('cached');
    store.startRun('r4', 'explicit', 'full');
    store.finishRun('r4', makeResult());
    expect(useResultsStore.getState().pending).toBe(false);
  });

  it('a newer pending edit survives an older run\'s terminal transition, because its pass re-raises pending in the debounce window', () => {
    const store = useResultsStore.getState();
    // Older run settles while a newer edit is pending (no run of its own
    // started yet, so runId still matches the older run).
    store.startRun('older', 'explicit', 'full');
    store.beginPending('cached');

    store.failRun('older', 'boom');
    const afterFail = useResultsStore.getState();
    expect(afterFail.pending).toBe(false);
    expect(afterFail.running).toBe(false);

    // The newer edit's pass starts normally afterwards and shows a run.
    store.startRun('newer', 'live', 'cached');
    expect(useResultsStore.getState().running).toBe(true);
    expect(useResultsStore.getState().pending).toBe(false);
  });
});
