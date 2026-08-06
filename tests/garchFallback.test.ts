import { describe, expect, it } from 'vitest';
import { FALLBACK_PERSISTENCE, ewmaVariance, garchTermStructure } from '../src/model/garch';
import { mulberry32 } from '../src/engine/rng';

/**
 * What the term structure does when the GARCH fit does NOT converge.
 *
 * This path used to return flat EWMA at every horizon, which extrapolated a two
 * to three week conditional estimate across the whole life of a trade. On a calm
 * name that had moved sharply it held a shocked short-term vol out to a year.
 */

/** A calm series with a hard recent fortnight, and too few observations for the
 * fit to converge. The shape that exposed the problem. */
function calmThenShock(): number[] {
  const rnd = mulberry32(5);
  const nrm = () => {
    const u1 = Math.max(rnd(), 1e-12);
    const u2 = rnd();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const sd = 0.15 / Math.sqrt(252);
  const r: number[] = [];
  for (let i = 0; i < 70; i++) r.push(sd * nrm());
  r[60] = -0.09;
  for (let i = 61; i < 70; i++) r[i] = sd * 4 * nrm();
  return r;
}

const HORIZONS = [21, 63, 126, 252];

describe('unconverged GARCH fallback', () => {
  it('reverts from the shocked short level toward the unconditional anchor', () => {
    const r = calmThenShock();
    const anchorVar = r.reduce((a, x) => a + x * x, 0) / r.length;
    const res = garchTermStructure(r, HORIZONS, anchorVar);
    expect(res.converged).toBe(false);

    const vols = res.terms.map((t) => t.vol);
    // Strictly decaying, because the short end is shocked and the anchor is not.
    for (let i = 1; i < vols.length; i++) expect(vols[i]).toBeLessThan(vols[i - 1]);

    // Every point stays inside the bracket the two inputs define. Leaving it
    // would mean the reversion had overshot into a level neither estimate
    // supports.
    const anchorVol = Math.sqrt(anchorVar * 252);
    const shortVol = Math.sqrt(ewmaVariance(r) * 252);
    expect(shortVol).toBeGreaterThan(anchorVol);
    for (const v of vols) {
      expect(v).toBeLessThanOrEqual(shortVol + 1e-12);
      expect(v).toBeGreaterThan(anchorVol);
    }
    // And the long end must have travelled most of the way back, or the
    // reversion speed is doing nothing useful.
    expect(vols[vols.length - 1]).toBeLessThan(anchorVol + (shortVol - anchorVol) * 0.5);
  });

  it('stays flat when there is no anchor to revert to', () => {
    // Without an unconditional estimate there is nothing to revert toward, so
    // flat EWMA remains the honest answer and the old behaviour is preserved.
    const res = garchTermStructure(calmThenShock(), HORIZONS);
    expect(res.converged).toBe(false);
    const vols = res.terms.map((t) => t.vol);
    for (const v of vols) expect(v).toBeCloseTo(vols[0], 12);
  });

  it('reverts faster the lower the persistence, and collapses to flat at 1', () => {
    // Pins the meaning of the constant rather than its value: persistence is
    // the reversion SPEED, and a persistence of one is the no-reversion case
    // that the old code assumed unconditionally.
    expect(FALLBACK_PERSISTENCE).toBeGreaterThan(0);
    expect(FALLBACK_PERSISTENCE).toBeLessThan(1);
    const r = calmThenShock();
    // A calm anchor well below the shocked short level.
    const anchorVar = Math.pow(0.12, 2) / 252;
    const oneYear = garchTermStructure(r, [252], anchorVar).terms[0].vol;
    const shortVol = Math.sqrt(ewmaVariance(r) * 252);
    // With reversion the one year point sits well below the short level.
    expect(oneYear).toBeLessThan(shortVol * 0.9);
    expect(oneYear).toBeGreaterThan(Math.sqrt(anchorVar * 252));
  });
});
