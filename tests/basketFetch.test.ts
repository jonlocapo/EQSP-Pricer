import { describe, expect, it, vi, beforeEach } from 'vitest';

// Stub the network-facing services `basketFetch.ts` calls, so these tests
// drive the concurrency and failure-isolation LOGIC only, never the real
// network. Partial mocks: `realizedCorrelationMatrix` is swapped out, but
// `marketFetch`'s other exports (unused here) stay real via importOriginal.
vi.mock('../src/services/volPipeline', () => ({
  fetchVolPipeline: vi.fn(),
}));
vi.mock('../src/services/spotFetch', () => ({
  fetchSpot: vi.fn(),
}));
vi.mock('../src/services/marketFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/marketFetch')>();
  return { ...actual, realizedCorrelationMatrix: vi.fn() };
});

import { fetchVolPipeline } from '../src/services/volPipeline';
import { fetchSpot } from '../src/services/spotFetch';
import { realizedCorrelationMatrix } from '../src/services/marketFetch';
import { fetchExtraLegsLive } from '../src/components/basketFetch';
import { useMarketStore, DEFAULT_LEG_CORRELATION } from '../src/state/marketStore';

const mockedVolPipeline = vi.mocked(fetchVolPipeline);
const mockedSpot = vi.mocked(fetchSpot);
const mockedCorr = vi.mocked(realizedCorrelationMatrix);

/** Resets the store to a fresh two-extra-leg basket (3 legs total) before
 * every test, so each test starts from known ticker/vol/dividend values. */
beforeEach(() => {
  mockedVolPipeline.mockReset();
  mockedSpot.mockReset();
  mockedCorr.mockReset();
  useMarketStore.setState({
    ticker: 'PRIMARY',
    underlyingName: 'Primary Co',
    market: { ...useMarketStore.getState().market, spot: 100, vol: 0.2, divYield: 0.01 },
    extraLegs: [
      { ticker: 'LEG_A', name: 'Leg A Co', vol: 0.1, divYield: 0.0 },
      { ticker: 'LEG_B', name: 'Leg B Co', vol: 0.1, divYield: 0.0 },
    ],
    basketCorrelation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    basketCorrelationSource: 'default',
  });
  // A history fetch is not the focus of the leg-vol tests below; keep it a
  // harmless no-op unless a test overrides it.
  mockedCorr.mockResolvedValue({ matrix: [[1, 1, 1], [1, 1, 1], [1, 1, 1]], errors: [] });
});

describe('fetchExtraLegsLive', () => {
  it('writes a volatility and a dividend into every extra leg, fetched concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockedSpot.mockResolvedValue({ spot: 50, asOf: '2024-01-01', source: 'test' });
    mockedVolPipeline.mockImplementation(async ({ symbol }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        surface: { spotRef: 100, slices: [], source: 'test', isFlat: true },
        atmVol: symbol === 'LEG_A' ? 0.33 : 0.44,
        divYield: symbol === 'LEG_A' ? 0.02 : 0.03,
        kind: 'realized' as const,
        label: 'test source',
      };
    });

    await fetchExtraLegsLive(1, 0.02, () => true);

    const legs = useMarketStore.getState().extraLegs;
    expect(legs[0].vol).toBeCloseTo(0.33, 9);
    expect(legs[0].divYield).toBeCloseTo(0.02, 9);
    expect(legs[1].vol).toBeCloseTo(0.44, 9);
    expect(legs[1].divYield).toBeCloseTo(0.03, 9);
    // Both legs' pipeline calls overlapped in time, i.e. Promise.all, not a
    // serial await loop.
    expect(maxInFlight).toBe(2);
  });

  it('leaves the other leg and the primary intact when one leg fails', async () => {
    mockedSpot.mockResolvedValue({ spot: 50, asOf: '2024-01-01', source: 'test' });
    mockedVolPipeline.mockImplementation(async ({ symbol }) => {
      if (symbol === 'LEG_A') throw new Error('network exploded');
      return {
        surface: { spotRef: 100, slices: [], source: 'test', isFlat: true },
        atmVol: 0.55,
        divYield: 0.04,
        kind: 'realized' as const,
        label: 'test source',
      };
    });
    const primaryVolBefore = useMarketStore.getState().market.vol;

    const lines = await fetchExtraLegsLive(1, 0.02, () => true);

    const legs = useMarketStore.getState().extraLegs;
    // The failing leg (A) kept its original vol/dividend...
    expect(legs[0].vol).toBeCloseTo(0.1, 9);
    expect(legs[0].divYield).toBeCloseTo(0.0, 9);
    // ...while the healthy leg (B) still got its result...
    expect(legs[1].vol).toBeCloseTo(0.55, 9);
    expect(legs[1].divYield).toBeCloseTo(0.04, 9);
    // ...and the primary leg, which this function never touches, is
    // completely unaffected.
    expect(useMarketStore.getState().market.vol).toBe(primaryVolBefore);
    // The failure is reported, not swallowed.
    expect(lines.some((l) => l.kind === 'info' && l.msg.includes('Leg A Co'))).toBe(true);
  });

  it('defaults an unmeasured correlation pair to DEFAULT_LEG_CORRELATION, not zero', async () => {
    mockedSpot.mockResolvedValue({ spot: 50, asOf: '2024-01-01', source: 'test' });
    mockedVolPipeline.mockResolvedValue({
      surface: { spotRef: 100, slices: [], source: 'test', isFlat: true },
      atmVol: 0.2,
      divYield: 0.01,
      kind: 'realized' as const,
      label: 'test source',
    });
    // Pair (0,1) measured at 0.6; pair (0,2) and (1,2) could not be
    // measured, which realizedCorrelationMatrix itself represents as 0.
    mockedCorr.mockResolvedValue({
      matrix: [
        [1, 0.6, 0],
        [0.6, 1, 0],
        [0, 0, 1],
      ],
      errors: ['PRIMARY/LEG_B: no history'],
    });

    await fetchExtraLegsLive(1, 0.02, () => true);

    const { basketCorrelation, basketCorrelationSource } = useMarketStore.getState();
    expect(basketCorrelation[0][1]).toBeCloseTo(0.6, 9);
    expect(basketCorrelation[0][2]).toBe(DEFAULT_LEG_CORRELATION);
    expect(basketCorrelation[1][2]).toBe(DEFAULT_LEG_CORRELATION);
    expect(basketCorrelationSource).toBe('history'); // at least one pair was genuinely measured
  });
});
