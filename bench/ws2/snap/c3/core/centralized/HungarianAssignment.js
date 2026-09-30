// ==========================================================================
// NODEX - Hungarian (Kuhn-Munkres) assignment, System 1 (Centralized) only.
// Solves the one-to-one minimum-cost assignment of a batch of open tasks to
// available robots on the central server. Rectangular matrices are padded
// with a large dummy cost; dummy pairs are dropped from the result.
// O(n^3) shortest augmenting path formulation (potentials u, v).
// ==========================================================================

const DUMMY = 1e9;

/**
 * @param {number[][]} cost - rows = robots, cols = tasks (finite numbers; use
 *   Infinity for infeasible pairs).
 * @returns {Array<[number, number]>} list of [row, col] pairs actually assigned.
 */
export function hungarian(cost) {
  const nRows = cost.length;
  const nCols = nRows ? cost[0].length : 0;
  if (!nRows || !nCols) return [];
  const n = Math.max(nRows, nCols);
  const a = (i, j) => {
    if (i >= nRows || j >= nCols) return DUMMY;
    const c = cost[i][j];
    return Number.isFinite(c) ? c : DUMMY;
  };
  // 1-indexed arrays as in the classic formulation.
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1), way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const result = [];
  for (let j = 1; j <= n; j++) {
    const i = p[j] - 1, c = j - 1;
    if (i < nRows && c < nCols && Number.isFinite(cost[i][c])) result.push([i, c]);
  }
  return result;
}
