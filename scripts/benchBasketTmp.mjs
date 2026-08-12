// Temporary basket-only timing harness (deleted after the measurement).
import { performance } from 'node:perf_hooks';
import { executePriceRequest } from '../src/worker/pricing.ts';
import { __clearPathCacheForTests } from '../src/engine/pathCache.ts';

const market = {
  spot: 100,
  vol: 0.22,
  rate: 0.025,
  divYield: 0.018,
  currency: 'EUR',
  basket: {
    assets: [
      { vol: 0.22, divYield: 0.018 },
      { vol: 0.31, divYield: 0.026 },
      { vol: 0.27, divYield: 0.011 },
    ],
    correlation: [
      [1, 0.55, 0.4],
      [0.55, 1, 0.45],
      [0.4, 0.45, 1],
    ],
  },
};

const spec = {
  kind: 'coupon',
  underlyings: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
  notional: 1_000_000,
  tenorYears: 2,
  reofferPct: 98.5,
  issuePricePct: 100,
  barrierType: 'american',
  kiBarrierPct: 60,
  putStrikePct: 100,
  downsideLeveragePct: 100,
  callType: 'constant',
  callFrequency: 'quarterly',
  callFromPeriod: 2,
  callBarrierPct: 100,
  stepDownPct: 0,
  customCallBarriersPct: [],
  couponType: 'conditional',
  couponFrequency: 'quarterly',
  couponBarrierPct: 60,
  couponPaPct: 9,
  acCouponType: 'none',
  acCouponPct: 0,
};

const hooks = { onProgress: () => {}, isCancelled: () => false, yieldNow: () => Promise.resolve() };
const req = { id: 'b', product: spec, market, mc: { numPaths: 100_000, seed: 42, antithetic: true }, solve: { kind: 'none' }, greeks: false };

const cold = [];
const warm = [];
for (let i = 0; i < 5; i++) {
  __clearPathCacheForTests();
  let t = performance.now();
  const res = await executePriceRequest(req, hooks);
  cold.push(performance.now() - t);
  t = performance.now();
  await executePriceRequest({ ...req, product: { ...spec, couponBarrierPct: 65 } }, hooks);
  warm.push(performance.now() - t);
  if (i === 0) console.log('pv', res.pvPct);
}
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`cold ${med(cold).toFixed(0)}ms  warm ${med(warm).toFixed(0)}ms`);
