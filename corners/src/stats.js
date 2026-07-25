// Distribution + regression helpers.
//
// Corners are overdispersed relative to Poisson (variance/mean typically runs
// 1.10-1.30 on match totals), so the negative binomial is the honest default.
// Poisson is kept for comparison — if NB does not beat it on log-loss, the
// overdispersion is not real in your sample and the simpler model wins.

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function poissonPmf(k, mu) {
  if (mu <= 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(mu) - mu - logGamma(k + 1));
}

// NB parameterised by mean and dispersion r: var = mu + mu^2/r.
// r -> Infinity recovers Poisson.
export function negBinPmf(k, mu, r) {
  if (!isFinite(r) || r > 1e6) return poissonPmf(k, mu);
  if (mu <= 0) return k === 0 ? 1 : 0;
  const lp =
    logGamma(k + r) - logGamma(r) - logGamma(k + 1) +
    r * Math.log(r / (r + mu)) + k * Math.log(mu / (r + mu));
  return Math.exp(lp);
}

// P(X > line) for a half-integer line (e.g. 10.5 -> P(X >= 11)).
export function probOver(line, mu, r = Infinity) {
  const maxK = Math.floor(line);
  let cdf = 0;
  for (let k = 0; k <= maxK; k++) cdf += negBinPmf(k, mu, r);
  return Math.min(1, Math.max(0, 1 - cdf));
}

// Method-of-moments dispersion from residuals. Returns Infinity when the
// sample is underdispersed (i.e. Poisson or tighter).
export function estimateDispersion(actuals, means) {
  const n = actuals.length;
  if (!n) return Infinity;
  let sqErr = 0, muBar = 0;
  for (let i = 0; i < n; i++) {
    const d = actuals[i] - means[i];
    sqErr += d * d;
    muBar += means[i];
  }
  const variance = sqErr / n;
  muBar /= n;
  if (variance <= muBar) return Infinity;
  return (muBar * muBar) / (variance - muBar);
}

// Ridge-regularised OLS via normal equations. X includes its own intercept
// column. Ridge keeps the solve stable when features are collinear (baseline
// and its interaction term usually are).
export function fitOLS(X, y, ridge = 1e-6) {
  const n = X.length, p = X[0].length;
  const A = Array.from({ length: p }, () => new Float64Array(p));
  const b = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 1; j < p; j++) A[j][j] += ridge * n; // never penalise the intercept
  return solve(A, b, p);
}

function solve(A, b, p) {
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null; // singular
    [A[col], A[piv]] = [A[piv], A[col]];
    const tb = b[col]; b[col] = b[piv]; b[piv] = tb;
    for (let r = col + 1; r < p; r++) {
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let c = col; c < p; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(p);
  for (let r = p - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < p; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return Array.from(x);
}

export const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export const mae = (act, pred) => mean(act.map((a, i) => Math.abs(a - pred[i])));
export const rmse = (act, pred) => Math.sqrt(mean(act.map((a, i) => (a - pred[i]) ** 2)));

export function logLoss(outcomes, probs) {
  const eps = 1e-9;
  return -mean(outcomes.map((o, i) => {
    const p = Math.min(1 - eps, Math.max(eps, probs[i]));
    return o ? Math.log(p) : Math.log(1 - p);
  }));
}

// Wilson score interval — honest error bars on a hit rate.
export function wilson(hits, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = hits / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - half), Math.min(1, c + half)];
}

// Remove the bookmaker's overround proportionally.
export function noVig3(o1, ox, o2) {
  if (!(o1 > 1 && ox > 1 && o2 > 1)) return null;
  const r = [1 / o1, 1 / ox, 1 / o2];
  const s = r[0] + r[1] + r[2];
  return { home: r[0] / s, draw: r[1] / s, away: r[2] / s, overround: s - 1 };
}
