/**
 * Pricing benchmark. Measures the scenarios that matter for the sub-second
 * target, so speed work is verified against numbers rather than assumed.
 *
 * Run: node --experimental-strip-types scripts/bench.mjs
 *  or: npx vite-node scripts/bench.mjs
 *
 * Reports, per scenario: a cold price (empty caches — the dominant cost is
 * path generation), a warm reprice with only a product term changed (should
 * hit the path + observables caches), and a warm-started solve.
 */
import { performance } from 'node:perf_hooks';
import { executePriceRequest } from '../src/worker/pricing.ts';
import { __clearPathCacheForTests } from '../src/engine/pathCache.ts';

const market = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

const hooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

const coupon = {
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

const couponAmerican = { ...coupon, barrierType: 'american' };

const booster = {
  kind: 'participation',
  underlyings: [{ name: 'TEST' }],
  currency: 'EUR',
  notional: 1_000_000,
  tenorYears: 1,
  reofferPct: 100,
  issuePricePct: 100,
  upside: { strikePct: 100, participationPct: 150, variant: { variant: 'vanilla' } },
  downside: { strikePct: 100, leveragePct: 100, barrierType: 'none', kiBarrierPct: 60, twinWinPct: 0 },
  bonusPct: 0,
  protectionPct: 0,
};

function req(product, overrides = {}) {
  return {
    id: 'bench',
    product,
    market,
    mc: { numPaths: 100_000, seed: 42, antithetic: true },
    solve: { kind: 'none' },
    greeks: false,
    ...overrides,
  };
}

async function time(label, fn) {
  const t0 = performance.now();
  const r = await fn();
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms   ${r ?? ''}`);
  return ms;
}

async function scenario(name, product, solveTarget) {
  console.log(`\n${name}`);
  __clearPathCacheForTests();
  await time('cold price (generate paths)', async () => {
    const r = await executePriceRequest(req(product), hooks);
    return `PV ${r.pvPct.toFixed(3)}%`;
  });
  // Only a product term changes -> should reuse cached paths.
  const tweaked = product.kind === 'coupon'
    ? { ...product, couponBarrierPct: product.couponBarrierPct + 1 }
    : { ...product, upside: { ...product.upside, participationPct: 151 } };
  await time('warm reprice (cached paths)', async () => {
    const r = await executePriceRequest(req(tweaked), hooks);
    return `PV ${r.pvPct.toFixed(3)}%`;
  });
  if (solveTarget) {
    __clearPathCacheForTests();
    let root;
    await time(`cold solve (${solveTarget})`, async () => {
      const r = await executePriceRequest(req(product, { solve: { kind: solveTarget } }), hooks);
      root = r.solvedValue;
      return `x=${r.solvedValue.toFixed(4)} (${r.solveIterations} iters)`;
    });
    // Seed the warm start with the value a live re-solve would actually have on
    // hand — the previous solved value. Seeding an arbitrary number makes the
    // tight bracket miss the root, so the solver silently cold-starts and the
    // measurement says nothing about the warm path.
    await time(`warm solve (${solveTarget})`, async () => {
      const r = await executePriceRequest(
        req(product, { solve: { kind: solveTarget }, warmStartValue: root }),
        hooks,
      );
      return `x=${r.solvedValue.toFixed(4)} (${r.solveIterations} iters, ${r.solveWarmStart ? 'warm' : 'cold'})`;
    });
  }
}

console.log('EQSP Pricer benchmark — 100k paths, antithetic, seed 42');
await scenario('Coupon, EUROPEAN KI, quarterly (the default)', coupon, 'couponPa');
await scenario('Coupon, AMERICAN KI (needs daily path)', couponAmerican, 'couponPa');
await scenario('Participation booster (pure terminal payoff)', booster);
console.log('');
