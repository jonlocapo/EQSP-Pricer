import type { PriceRequest, PriceResult } from '../model/request';
import type { PricerClient, ProfileProgressUpdate, ProgressUpdate } from './client';
import type { ProfileRequest, ProfileResult } from './protocol';
import { chebyshevLobattoSpotNodes } from '../engine/chebyshev';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function callObservationCount(req: PriceRequest): number {
  const { product } = req;
  if (product.kind !== 'coupon') return 0;
  if (product.callType === 'none') return 0;
  const perYear = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 }[product.callFrequency];
  return Math.max(1, Math.round(product.tenorYears * perYear));
}

/**
 * Fake pricing client for phase-1 UI development: emits progress ticks over
 * ~1.5s then resolves a plausible-looking PriceResult. Respects cancel().
 */
export class MockPricerClient implements PricerClient {
  private cancelled = new Set<string>();

  async price(req: PriceRequest, onProgress: (p: ProgressUpdate) => void): Promise<PriceResult> {
    this.cancelled.delete(req.id);
    const rand = mulberry32(
      req.mc.seed + req.id.split('').reduce((s, c) => s + c.charCodeAt(0), 0)
    );
    const start = Date.now();
    const total = req.mc.numPaths;
    const ticks = 12;
    const willSolve = req.solve.kind !== 'none';

    for (let i = 1; i <= ticks; i++) {
      if (this.cancelled.has(req.id)) {
        throw new Error('cancelled');
      }
      await sleep(1500 / ticks);
      const phase: ProgressUpdate['phase'] = willSolve && i > ticks * 0.6 ? 'solving' : 'pricing';
      onProgress({
        pathsDone: Math.round((total * i) / ticks),
        pathsTotal: total,
        phase,
        solveIteration: phase === 'solving' ? Math.ceil(((i - ticks * 0.6) / (ticks * 0.4)) * 5) : undefined,
      });
    }

    if (req.greeks) {
      if (this.cancelled.has(req.id)) throw new Error('cancelled');
      await sleep(120);
      onProgress({ pathsDone: total, pathsTotal: total, phase: 'greeks' });
    }

    if (this.cancelled.has(req.id)) {
      throw new Error('cancelled');
    }

    const noise = (rand() - 0.5) * 0.6; // +/- 0.3 pt
    let targetPct: number;
    let notional: number;
    if (req.product.kind === 'accumulator') {
      targetPct = req.product.upfrontPct * 100;
      notional =
        req.product.dailyShares *
        Math.round(req.product.tenorYears * 252) *
        (req.product.strikePct / 100) *
        req.market.spot;
    } else {
      targetPct = req.product.reofferPct;
      notional = req.product.notional;
    }
    const pvPct = targetPct + (willSolve ? 0 : noise);
    const stderrPct = 0.03 + rand() * 0.04;
    const pvCcy = (pvPct / 100) * notional;

    let solvedValue: number | undefined;
    if (willSolve) {
      switch (req.solve.kind) {
        case 'couponPa':
        case 'acCouponPa':
          solvedValue = 4 + rand() * 8;
          break;
        case 'couponBarrier':
        case 'callBarrier':
        case 'kiBarrier':
        case 'upsideKoBarrier':
          solvedValue = 55 + rand() * 40;
          break;
        case 'gearing':
          solvedValue = 100 + rand() * 100;
          break;
        case 'upsideStrike':
          solvedValue = 90 + rand() * 30;
          break;
        case 'twinWin':
          solvedValue = rand() * 100;
          break;
        case 'bonusLevel':
          solvedValue = 5 + rand() * 25;
          break;
        case 'upperStrike':
          solvedValue = 105 + rand() * 20;
          break;
        case 'rebate':
          solvedValue = rand() * 15;
          break;
        case 'strike':
          solvedValue = 85 + rand() * 20;
          break;
        case 'upfront':
          solvedValue = rand() * 3;
          break;
        default:
          solvedValue = undefined;
      }
    }

    const nCalls = callObservationCount(req);
    const callProb =
      nCalls > 0
        ? Array.from({ length: nCalls }, (_, i) => {
            const base = 0.04 + (i / nCalls) * 0.5;
            return Math.max(0, Math.min(1, base + (rand() - 0.5) * 0.1));
          })
        : undefined;

    const result: PriceResult = {
      id: req.id,
      pvPct,
      pvCcy,
      stderrPct,
      ci95Pct: [pvPct - 1.96 * stderrPct, pvPct + 1.96 * stderrPct],
      solvedValue,
      solveIterations: willSolve ? 5 : undefined,
      greeks: req.greeks ? { deltaPct: (rand() - 0.5) * 0.8, vegaPct: (rand() - 0.3) * 0.4 } : undefined,
      diagnostics: {
        callProb,
        kiProb: req.product.kind !== 'accumulator' ? rand() * 0.3 : undefined,
        upsideKoProb:
          req.product.kind === 'participation' && req.product.upside.variant.variant === 'koRebate'
            ? rand() * 0.4
            : undefined,
        koProb: req.product.kind === 'accumulator' ? rand() * 0.5 : undefined,
        expectedLifeYears: req.product.tenorYears * (0.5 + rand() * 0.5),
      },
      elapsedMs: Date.now() - start,
    };
    return result;
  }

  cancel(id: string): void {
    this.cancelled.add(id);
  }

  /** Fake profile run: emits a node-level progress tick per node, then
   * resolves a plausible (smooth, since it's a simple analytic curve in
   * spot with only mild noise) set of node samples. Dev-only fake — the
   * real behavior lives in WorkerPricerClient/executeProfileRequest. */
  async profile(req: ProfileRequest, onProgress: (p: ProfileProgressUpdate) => void): Promise<ProfileResult> {
    this.cancelled.delete(req.id);
    const N = req.N ?? 32;
    const rangeFrac = req.rangeFrac ?? 0.5;
    const spotLo = req.market.spot * (1 - rangeFrac);
    const spotHi = req.market.spot * (1 + rangeFrac);
    const spotNodes = chebyshevLobattoSpotNodes(N, spotLo, spotHi);
    const targetPct = req.product.kind === 'accumulator' ? req.product.upfrontPct * 100 : req.product.reofferPct;

    const nodes: ProfileResult['nodes'] = [];
    for (let k = 0; k <= N; k++) {
      if (this.cancelled.has(req.id)) throw new Error('cancelled');
      await sleep(8);
      const spot = spotNodes[k];
      // A smooth-ish fake PV curve: sigmoid-like in log-moneyness around par.
      const logM = Math.log(spot / req.market.spot);
      const pvPct = targetPct - 15 * Math.tanh(logM) + 2 * logM * logM;
      nodes.push({ spot, pvPct, stderrPct: 0.03 });
      onProgress({ nodesDone: k + 1, nodesTotal: N + 1 });
    }
    if (this.cancelled.has(req.id)) throw new Error('cancelled');
    return { id: req.id, nodes, spotLo, spotHi, N };
  }
}
