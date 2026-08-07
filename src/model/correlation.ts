/**
 * Correlation-matrix validation and repair for worst-of baskets.
 *
 * A valid correlation matrix is symmetric, has ones on the diagonal, and is
 * positive semi-definite (PSD). `isPsd` checks those three properties.
 * `repairCorrelation` turns any numeric matrix into a valid correlation
 * matrix. It never rejects an input.
 *
 * WHY repair instead of reject: per-entry [-1, 1] bounds are not enough at
 * N >= 3. Three pairwise-legal correlations can still be non-PSD, and then a
 * Cholesky factorization just fails. Rejecting leaves the user stuck with a
 * basket that cannot price. Repair keeps the basket alive.
 *
 * The repair projects onto the PSD cone by clipping negative eigenvalues and
 * then renormalizes the rows so the diagonal returns to one. The iteration
 * runs a bounded number of times; a congruence keeps the clipped matrix PSD.
 */

/** Tolerated departure of a diagonal entry from one. */
const DIAG_TOL = 1e-9;
/** Tolerated negative eigenvalue, relative to zero. */
const EIG_TOL = 1e-9;
/** Off-diagonal norm below which a Jacobi sweep stops. */
const JACOBI_TOL = 1e-12;
/** Maximum Jacobi sweeps for one decomposition. */
const MAX_SWEEPS = 100;
/** Maximum clip-and-renormalize passes for one repair. */
const MAX_ITER = 100;

/** True when `matrix` is square, has a unit diagonal, and is PSD. Non-finite
 * entries or an asymmetric matrix make the answer false. */
export function isPsd(matrix: number[][]): boolean {
  const n = matrix.length;
  if (n === 0) return false;
  for (const row of matrix) {
    if (row.length !== n) return false;
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!Number.isFinite(matrix[i][j])) return false;
    }
  }
  for (let i = 0; i < n; i++) {
    if (!(Math.abs(matrix[i][i] - 1) <= DIAG_TOL)) return false;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!(Math.abs(matrix[i][j] - matrix[j][i]) <= DIAG_TOL)) return false;
    }
  }
  const { values } = jacobiEigen(matrix);
  for (const lambda of values) {
    if (!(lambda >= -EIG_TOL)) return false;
  }
  return true;
}

/** Returns a valid correlation matrix for any numeric input. An input that is
 * already a valid correlation matrix comes back unchanged. */
export function repairCorrelation(matrix: number[][]): number[][] {
  const n = matrix.length;
  if (n === 0) return [];
  if (isPsd(matrix)) return matrix;

  const a = alloc(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = matrix[i][j];
      const y = matrix[j] ? matrix[j][i] : x;
      a[i][j] = Number.isFinite(x) && Number.isFinite(y) ? 0.5 * (x + y) : 0;
    }
    a[i][i] = 1;
  }

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const { values, vectors } = jacobiEigen(a);
    const c = alloc(n);
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          const lambda = values[k] < 0 ? 0 : values[k];
          if (lambda === 0) continue;
          sum += lambda * vectors[i][k] * vectors[j][k];
        }
        c[i][j] = sum;
        c[j][i] = sum;
      }
    }
    let anyValid = false;
    for (let i = 0; i < n; i++) {
      const d = c[i][i];
      if (!(d > 0) || !Number.isFinite(d)) continue;
      anyValid = true;
      const scale = 1 / Math.sqrt(d);
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        c[i][j] *= scale;
        c[j][i] *= scale;
      }
      c[i][i] = 1;
    }
    if (!anyValid) return identity(n);
    for (let i = 0; i < n; i++) c[i][i] = 1;
    let maxDiagError = 0;
    for (let i = 0; i < n; i++) {
      maxDiagError = Math.max(maxDiagError, Math.abs(c[i][i] - 1));
    }
    if (maxDiagError <= DIAG_TOL) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (!Number.isFinite(c[i][j])) return identity(n);
        }
      }
      return c;
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        a[i][j] = c[i][j];
      }
    }
  }

  for (let i = 0; i < n; i++) a[i][i] = 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!Number.isFinite(a[i][j])) return identity(n);
    }
  }
  return a;
}

/** Eigen-decomposition of a symmetric matrix by classic Jacobi rotations.
 * Each sweep rotates out the largest off-diagonal element until the
 * off-diagonal norm drops below `JACOBI_TOL` or `MAX_SWEEPS` sweeps pass.
 * The method is deterministic. */
function jacobiEigen(matrix: number[][]): { values: number[]; vectors: number[][] } {
  const n = matrix.length;
  const a = alloc(n);
  const vectors = alloc(n);
  for (let i = 0; i < n; i++) vectors[i][i] = 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = matrix[i][j];
      const y = matrix[j] ? matrix[j][i] : x;
      a[i][j] = Number.isFinite(x) && Number.isFinite(y) ? 0.5 * (x + y) : 0;
    }
  }
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let offDiagNorm = 0;
    let p = 0;
    let q = 1;
    let maxAbs = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const value = a[i][j];
        offDiagNorm += value * value;
        const absValue = Math.abs(value);
        if (absValue > maxAbs) {
          maxAbs = absValue;
          p = i;
          q = j;
        }
      }
    }
    offDiagNorm = Math.sqrt(offDiagNorm);
    if (offDiagNorm < JACOBI_TOL || maxAbs < JACOBI_TOL) break;
    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    for (let k = 0; k < n; k++) {
      if (k === p || k === q) continue;
      const akp = a[k][p];
      const akq = a[k][q];
      a[k][p] = c * akp - s * akq;
      a[k][q] = s * akp + c * akq;
      a[p][k] = a[k][p];
      a[q][k] = a[k][q];
    }
    a[p][p] = c * c * app - 2 * c * s * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * c * s * apq + c * c * aqq;
    a[p][q] = 0;
    a[q][p] = 0;
    for (let k = 0; k < n; k++) {
      const vkp = vectors[k][p];
      const vkq = vectors[k][q];
      vectors[k][p] = c * vkp - s * vkq;
      vectors[k][q] = s * vkp + c * vkq;
    }
  }
  const values = new Array(n);
  for (let i = 0; i < n; i++) values[i] = a[i][i];
  return { values, vectors };
}

/** An n-by-n zero matrix. */
function alloc(n: number): number[][] {
  const m = new Array(n);
  for (let i = 0; i < n; i++) m[i] = new Array(n).fill(0);
  return m;
}

/** An n-by-n identity matrix. */
function identity(n: number): number[][] {
  const m = alloc(n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

/**
 * Lower-triangular Cholesky factor `L` with `L * L^T = matrix`.
 *
 * Turning independent standard normals `z` into correlated ones is `L * z`,
 * which is what the basket path generator needs (see engine/gbm.ts).
 *
 * A correlation matrix that is only positive SEMI-definite, for example one
 * with a pair at correlation exactly 1, has a zero on the diagonal of `L`.
 * That is legitimate and must not throw: the leg is then a deterministic
 * multiple of an earlier one, which is exactly what correlation 1 means. So a
 * non-positive pivot clamps to zero and the remaining entries of that column
 * stay zero, rather than taking a square root of a negative number.
 *
 * Throws only on a matrix that is not square or not finite, because those are
 * caller mistakes rather than legitimate degenerate cases. Repair the matrix
 * with `repairCorrelation` first: this function assumes PSD and does not check
 * it, since the clamp silently absorbs a small negative eigenvalue and would
 * hide a badly wrong input.
 */
export function choleskyLower(matrix: number[][]): number[][] {
  const n = matrix.length;
  if (n === 0) throw new Error('cannot factor an empty matrix');
  for (const row of matrix) {
    if (row.length !== n) throw new Error('correlation matrix must be square');
    for (const v of row) {
      if (!Number.isFinite(v)) throw new Error('correlation matrix has a non-finite entry');
    }
  }
  const L = alloc(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        // Clamp rather than throw: a zero pivot is the perfectly-correlated
        // case, not an error.
        L[i][j] = sum > 0 ? Math.sqrt(sum) : 0;
      } else {
        L[i][j] = L[j][j] > 0 ? sum / L[j][j] : 0;
      }
    }
  }
  return L;
}
