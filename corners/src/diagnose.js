// Robustness diagnostic for the favourite-corners result.
//
//   node src/diagnose.js --data data/matches.json
//
// A single YES from backtest.js is not a finding until it survives three
// stress tests. This runs ONE walk-forward fav backtest, then slices its
// out-of-sample predictions to answer:
//
//   1. Is the signal spread across leagues, or concentrated in one?
//   2. Does it hold for AWAY favourites, or is it just home advantage in
//      disguise? (favourites are usually home; home teams win more corners.)
//   3. Is it a line-5.5 artifact, or robust across 4.5 / 5.5 / 6.5?
//
// The metric in every slice is the SAME one that matters in the verdict:
// does `fitted` beat `shrunk` on log-loss out of sample. Projections are
// reused across lines (the mean does not depend on the line), so the line
// sweep needs no refit.

import { readFileSync } from 'node:fs';
import { runBacktest } from './backtest.js';
import { overProbability } from './model.js';
import { logLoss, mae, wilson, mean } from './stats.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DATA = arg('data', 'data/matches.json');

const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
const rule = (n = 78) => console.log('-'.repeat(n));
const d4 = x => x.toFixed(4);

// Log-loss delta (shrunk - fitted) on an arbitrary subset at a given line.
// Positive = fitted is better = the mismatch signal is present in this slice.
function sliceLogLoss(preds, disp, line, filter) {
  const sub = preds.filter(p => filter(p.row));
  if (sub.length < 30) return { n: sub.length, thin: true };
  const over = sub.map(p => (p.row.actual > line ? 1 : 0));
  const llShr = logLoss(over, sub.map(p => overProbability(p.shr, line, disp)));
  const llFit = logLoss(over, sub.map(p => overProbability(p.fitd, line, disp)));
  const maeShr = mae(sub.map(p => p.row.actual), sub.map(p => p.shr));
  const maeFit = mae(sub.map(p => p.row.actual), sub.map(p => p.fitd));
  return {
    n: sub.length,
    llShr, llFit, llGain: llShr - llFit,
    maeGain: ((maeShr - maeFit) / maeShr) * 100,
    baseRate: mean(over),
  };
}

function row(label, r) {
  if (r.thin) { console.log(pad(label, 26) + pad(r.n, 7, true) + '   (thin — skipped)'); return; }
  const verdict = r.llGain > 0.0005 ? 'holds' : (r.llGain < -0.0005 ? 'GONE' : 'flat');
  console.log(
    pad(label, 26) + pad(r.n, 7, true) +
    pad(d4(r.llShr), 11, true) + pad(d4(r.llFit), 11, true) +
    pad((r.llGain >= 0 ? '+' : '') + d4(r.llGain), 11, true) +
    pad((r.maeGain >= 0 ? '+' : '') + r.maeGain.toFixed(2) + '%', 10, true) +
    '   ' + verdict,
  );
}

const matches = JSON.parse(readFileSync(DATA, 'utf8'));
const res = runBacktest(matches, { line: 5.5, target: 'fav' });
if (res.error) { console.error('ERROR: ' + res.error); process.exit(1); }
const { preds, disp } = res;

const LEAGUE_NAMES = {
  S15050: 'England Premier League', S14956: 'Spain La Liga', S15068: 'Italy Serie A',
  S14968: 'Germany Bundesliga', S14932: 'France Ligue 1', S14930: 'England Championship',
};

console.log(`\nFAVOURITE-CORNERS ROBUSTNESS DIAGNOSTIC  (${preds.length} out-of-sample fixtures)`);
console.log('metric = log-loss, shrunk vs fitted. positive llGain = mismatch signal present.\n');

console.log('1) BY LEAGUE  (line 5.5)');
rule();
console.log(pad('league', 26) + pad('n', 7, true) + pad('LL shrunk', 11, true) + pad('LL fitted', 11, true) + pad('llGain', 11, true) + pad('MAE gain', 10, true));
const leagues = [...new Set(preds.map(p => p.row.league))];
for (const lg of leagues) row(LEAGUE_NAMES[lg] || lg, sliceLogLoss(preds, disp, 5.5, r => r.league === lg));
row('ALL', sliceLogLoss(preds, disp, 5.5, () => true));

console.log('\n2) BY FAVOURITE VENUE  (line 5.5 — rules out home-advantage confound)');
rule();
console.log(pad('subset', 26) + pad('n', 7, true) + pad('LL shrunk', 11, true) + pad('LL fitted', 11, true) + pad('llGain', 11, true) + pad('MAE gain', 10, true));
row('home favourites', sliceLogLoss(preds, disp, 5.5, r => r.favIsHome === true));
row('away favourites', sliceLogLoss(preds, disp, 5.5, r => r.favIsHome === false));

console.log('\n3) BY LINE  (all fixtures — rules out a 5.5-specific artifact)');
rule();
console.log(pad('line', 26) + pad('n', 7, true) + pad('LL shrunk', 11, true) + pad('LL fitted', 11, true) + pad('llGain', 11, true) + pad('MAE gain', 10, true));
for (const line of [4.5, 5.5, 6.5]) row(`over ${line}`, sliceLogLoss(preds, disp, line, () => true));

console.log('\nHOW TO READ THIS');
rule();
console.log('The signal is trustworthy only if llGain stays positive in MOST leagues,');
console.log('survives for AWAY favourites (else it is just home advantage), and holds');
console.log('across lines. A single strong league or home-only effect is not a finding.');
console.log('');
console.log('Even if all three hold: this beats the naive shrunk baseline, NOT the book.');
console.log('Edge remains unmeasured until corner over/under prices are attached.');
