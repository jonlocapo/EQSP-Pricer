import { describe, expect, it, beforeEach } from 'vitest';
import { runPricing } from '../src/services/runPricing';
import { useResultsStore } from '../src/state/resultsStore';
import { setPricerClient } from '../src/worker/client';
import type { PricerClient, ProgressUpdate, ProfileProgressUpdate } from '../src/worker/client';
import type { PriceRequest, PriceResult } from '../src/model/request';
import type { ProfileRequest, ProfileResult } from '../src/worker/protocol';
import type { CouponProductSpec } from '../src/model/product';
import type { MarketData } from '../src/model/market';

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

const product: CouponProductSpec = {
  kind: 'coupon',
  underlyings: [{ name: 'TEST' }],
  currency: 'EUR',
  notional: 1_000_000,
  tenorYears: 1,
  reofferPct: 98.5,
  issuePricePct: 100,
  barrierType: 'european',
  kiBarrierPct: 60,
  putStrikePct: 100,
  downsideLeveragePct: 100,
  callType: 'constant',
  callFrequency: 'quarterly',
  callFromPeriod: 1,
  callBarrierPct: 100,
  stepDownPct: 0,
  customCallBarriersPct: [],
  couponType: 'conditional',
  couponFrequency: 'quarterly',
  couponBarrierPct: 60,
  couponPaPct: 8,
  acCouponType: 'none',
  acCouponPct: 0,
};

function makePriceResult(req: PriceRequest): PriceResult {
  return {
    id: req.id,
    pvPct: 98.5,
    pvCcy: 985_000,
    stderrPct: 0.05,
    ci95Pct: [98.4, 98.6],
    solvedValue: req.solve.kind === 'none' ? undefined : 8,
    diagnostics: {},
    elapsedMs: 10,
    preview: req.preview,
  };
}

/** A scriptable fake pricer client so each test controls exactly what the
 * "engine" does for its one price() call, without touching the real
 * engine/solver code (out of scope for this feature). */
class ScriptedClient implements PricerClient {
  constructor(private behavior: (req: PriceRequest) => PriceResult) {}
  async price(req: PriceRequest, _onProgress: (p: ProgressUpdate) => void): Promise<PriceResult> {
    return this.behavior(req);
  }
  cancel(): void {}
  async profile(req: ProfileRequest, _onProgress: (p: ProfileProgressUpdate) => void): Promise<ProfileResult> {
    return { id: req.id, nodes: [], spotLo: 0, spotHi: 0, N: 0 };
  }
}

class ThrowingClient implements PricerClient {
  constructor(private message: string) {}
  async price(): Promise<PriceResult> {
    throw new Error(this.message);
  }
  cancel(): void {}
  async profile(req: ProfileRequest): Promise<ProfileResult> {
    return { id: req.id, nodes: [], spotLo: 0, spotHi: 0, N: 0 };
  }
}

describe('runPricing live vs explicit failure handling', () => {
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

  it('a no-solve-target (solve.kind === "none") live pass runs a plain price and lands in finishRun', async () => {
    setPricerClient(new ScriptedClient(makePriceResult));

    await runPricing({
      page: 'coupon',
      product,
      market,
      underlyingName: 'TEST',
      solve: { kind: 'none' },
      greeks: false,
      live: true,
      addToHistory: false,
    });

    const state = useResultsStore.getState();
    expect(state.error).toBeNull();
    expect(state.liveUnsolvable).toBeNull();
    expect(state.result).not.toBeNull();
    expect(state.result!.pvPct).toBe(98.5);
    expect(state.result!.solvedValue).toBeUndefined();
  });

  it('a live pass that fails with "no solution / not reachable" sets the soft liveUnsolvable state, not error', async () => {
    setPricerClient(
      new ThrowingClient(
        'No solution for couponPa in [0, 100] — the target level is not reachable with these terms'
      )
    );
    // Seed a prior good result so we can assert it survives untouched.
    useResultsStore.getState().finishRun({
      id: 'prev',
      pvPct: 98.5,
      pvCcy: 985_000,
      stderrPct: 0.05,
      ci95Pct: [98.4, 98.6],
      solvedValue: 8,
      diagnostics: {},
      elapsedMs: 10,
    });
    const priorResult = useResultsStore.getState().result;

    await runPricing({
      page: 'coupon',
      product,
      market,
      underlyingName: 'TEST',
      solve: { kind: 'couponPa' },
      greeks: false,
      live: true,
      addToHistory: false,
    });

    const state = useResultsStore.getState();
    expect(state.error).toBeNull();
    expect(state.liveUnsolvable).not.toBeNull();
    // Last good result must be preserved, not wiped by the soft failure.
    expect(state.result).toBe(priorResult);
  });

  it('the SAME "no solution" failure on a non-live (explicit) run uses the alarming failRun/error path instead', async () => {
    setPricerClient(
      new ThrowingClient(
        'No solution for couponPa in [0, 100] — the target level is not reachable with these terms'
      )
    );

    await runPricing({
      page: 'coupon',
      product,
      market,
      underlyingName: 'TEST',
      solve: { kind: 'couponPa' },
      greeks: false,
      live: false,
    });

    const state = useResultsStore.getState();
    expect(state.error).not.toBeNull();
    expect(state.liveUnsolvable).toBeNull();
  });

  it('an unexpected (non-no-solution) error on a live pass still surfaces as a real error, not a soft hint', async () => {
    setPricerClient(new ThrowingClient('Worker crashed unexpectedly'));

    await runPricing({
      page: 'coupon',
      product,
      market,
      underlyingName: 'TEST',
      solve: { kind: 'couponPa' },
      greeks: false,
      live: true,
      addToHistory: false,
    });

    const state = useResultsStore.getState();
    expect(state.error).toBe('Worker crashed unexpectedly');
    expect(state.liveUnsolvable).toBeNull();
  });

  it('a cancelled run (superseded by a newer live pass) is neither an error nor a liveUnsolvable hint', async () => {
    setPricerClient(new ThrowingClient('cancelled'));

    await runPricing({
      page: 'coupon',
      product,
      market,
      underlyingName: 'TEST',
      solve: { kind: 'none' },
      greeks: false,
      live: true,
      addToHistory: false,
    });

    const state = useResultsStore.getState();
    expect(state.error).toBeNull();
    expect(state.liveUnsolvable).toBeNull();
    expect(state.running).toBe(false);
  });
});
