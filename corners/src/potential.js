// Does FootyStats' OWN pre-game corner projection predict the actual corner
// count? This tests their published `corners_potential` (and o85/o95/o105
// over-probabilities) directly against outcomes — the exact question:
// pre-game corner data in, actual corners out, is there a pattern?
//
//   node src/potential.js --data data/matches.json
//
// This is a straight relationship test (correlation / regression / calibration)
// on the whole sample — not a walk-forward bet. It answers "is there a pattern",
// which is what was asked.
//
// One honest check is built in: FootyStats computes corners_potential from
// season corner averages, which for a completed match include that match. That
// is mild look-ahead. So we also compare against the leak-free point-in-time
// baseline (MAE ~2.75 from backtest.js) — if `potential` predicts dramatically
// better than anything point-in-time could, the gap is leakage, not skill.

import { readFileSync } from 'node:fs';
import { fitOLS, mean, mae, rmse, wilson } from './stats.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DATA = arg('data', 'data/matches.json');

const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
const rule = (n = 74) => console.log('-'.repeat(n));
const pctS = x => `${(x * 100).toFixed(1)}%`;

function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

const raw = JSON.parse(readFileSync(DATA, 'utf8'));
const M = raw.filter(m =>
  m.potential && Number.isFinite(m.potential.total) && m.potential.total > 0 &&
  Number.isFinite(m.hc) && Number.isFinite(m.ac));

if (M.length < 100) {
  console.error(`Only ${M.length} matches carry a FootyStats corner projection.`);
  console.error('Re-fetch (fetch.js now captures the `potential` fields), then retry.');
  process.exit(1);
}

const actual = M.map(m => m.hc + m.ac);
const proj = M.map(m => m.potential.total);
const leagueMeanMAE = mae(actual, actual.map(() => mean(actual)));

console.log(`\nFOOTYSTATS PRE-GAME CORNER PROJECTION vs ACTUAL  (${M.length} matches)`);
console.log('question: does their published corners_potential predict the real total?\n');

// ---- 1. relationship ------------------------------------------------------
const r = pearson(proj, actual);
const coef = fitOLS(proj.map(p => [1, p]), actual, 0);
console.log('1) RELATIONSHIP');
rule();
console.log(`Pearson correlation      r = ${r.toFixed(3)}   (r^2 = ${(r * r).toFixed(3)})`);
console.log(`OLS  actual = ${coef[0].toFixed(2)} + ${coef[1].toFixed(2)} x projection`);
console.log(`  slope 1.0 + intercept 0.0 would mean the projection is perfectly unbiased.`);
console.log(`  projection range: ${Math.min(...proj).toFixed(1)}-${Math.max(...proj).toFixed(1)}   actual mean: ${mean(actual).toFixed(2)}`);

// ---- 2. accuracy vs the dumb baseline ------------------------------------
const projMAE = mae(actual, proj);
const projRMSE = rmse(actual, proj);
// de-biased: apply the fitted linear correction (removes any systematic offset)
const adj = proj.map(p => coef[0] + coef[1] * p);
const adjMAE = mae(actual, adj);
console.log('\n2) ACCURACY  (corners, lower is better)');
rule();
console.log(pad('predictor', 34) + pad('MAE', 10, true) + pad('RMSE', 10, true) + pad('vs league mean', 16, true));
console.log(pad('league mean (constant)', 34) + pad(leagueMeanMAE.toFixed(3), 10, true) + pad(rmse(actual, actual.map(() => mean(actual))).toFixed(3), 10, true) + pad('-', 16, true));
console.log(pad('FootyStats projection (raw)', 34) + pad(projMAE.toFixed(3), 10, true) + pad(projRMSE.toFixed(3), 10, true) + pad(`${((leagueMeanMAE - projMAE) / leagueMeanMAE * 100).toFixed(1)}%`, 16, true));
console.log(pad('FootyStats projection (de-biased)', 34) + pad(adjMAE.toFixed(3), 10, true) + pad('', 10, true) + pad(`${((leagueMeanMAE - adjMAE) / leagueMeanMAE * 100).toFixed(1)}%`, 16, true));
console.log(`\n  leak-free point-in-time baseline (from backtest.js) was ~2.75 MAE.`);
console.log(`  if the projection here is far below that, the gap is look-ahead, not skill.`);

// ---- 3. calibration of the projected level -------------------------------
console.log('\n3) CALIBRATION OF THE PROJECTED LEVEL');
rule();
console.log(pad('projected total', 18) + pad('n', 7, true) + pad('mean actual', 14, true) + pad('within band?', 14, true));
const bins = [[0, 8.5], [8.5, 9.5], [9.5, 10.5], [10.5, 11.5], [11.5, 12.5], [12.5, 99]];
for (const [lo, hi] of bins) {
  const idx = M.map((_, i) => i).filter(i => proj[i] >= lo && proj[i] < hi);
  if (idx.length < 15) continue;
  const a = idx.map(i => actual[i]);
  const label = hi === 99 ? `${lo}+` : `${lo}-${hi}`;
  const ma = mean(a);
  const mid = hi === 99 ? lo + 1 : (lo + hi) / 2;
  console.log(pad(label, 18) + pad(idx.length, 7, true) + pad(ma.toFixed(2), 14, true) + pad(Math.abs(ma - mid) < 0.75 ? 'yes' : 'off by ' + (ma - mid).toFixed(1), 14, true));
}

// ---- 4. do their over-probabilities calibrate? ---------------------------
const withO = M.map((m, i) => ({ m, i })).filter(({ m }) => Number.isFinite(m.potential.o105) && m.potential.o105 > 0);
if (withO.length >= 100) {
  let scale = Math.max(...withO.map(({ m }) => m.potential.o105)) > 1.5 ? 100 : 1;
  console.log(`\n4) THEIR P(over 10.5) vs REALITY  (${withO.length} matches, o105_potential)`);
  rule();
  console.log(pad('their prob', 14) + pad('n', 7, true) + pad('predicted', 12, true) + pad('actual', 10, true) + pad('95% CI', 18, true));
  const buckets = new Map();
  for (const { m, i } of withO) {
    const p = m.potential.o105 / scale;
    const b = Math.min(9, Math.floor(p * 10));
    if (!buckets.has(b)) buckets.set(b, { n: 0, hit: 0, sum: 0 });
    const e = buckets.get(b);
    e.n++; e.sum += p; e.hit += actual[i] > 10.5 ? 1 : 0;
  }
  for (const b of [...buckets.keys()].sort((a, z) => a - z)) {
    const e = buckets.get(b);
    if (e.n < 15) continue;
    const [lo, hi] = wilson(e.hit, e.n);
    console.log(pad(`${b * 10}-${b * 10 + 10}%`, 14) + pad(e.n, 7, true) + pad(pctS(e.sum / e.n), 12, true) + pad(pctS(e.hit / e.n), 10, true) + pad(`${pctS(lo)}-${pctS(hi)}`, 18, true));
  }
}

// ---- verdict --------------------------------------------------------------
console.log('\nVERDICT');
rule();
const gain = (leagueMeanMAE - projMAE) / leagueMeanMAE * 100;
if (r > 0.35 && gain > 5) {
  console.log(`Pattern: YES. The projection correlates r=${r.toFixed(2)} with actual corners and`);
  console.log(`cuts error ${gain.toFixed(0)}% below a constant. But check line 2 for look-ahead:`);
  console.log(`a leak-free model could not beat ~2.75 MAE, so anything well under that is`);
  console.log(`using end-of-season info a real pre-match model would not have had.`);
} else if (r > 0.2) {
  console.log(`Pattern: WEAK. Correlation r=${r.toFixed(2)}, error only ${gain.toFixed(1)}% below a constant.`);
  console.log(`There is a real but small relationship — the projection knows a little, not a lot.`);
} else {
  console.log(`Pattern: NO. Correlation r=${r.toFixed(2)}, error ${gain.toFixed(1)}% vs a constant.`);
  console.log(`Even FootyStats' own pre-game projection barely tracks the actual total —`);
  console.log(`confirming corner totals are dominated by irreducible per-game variance.`);
}
