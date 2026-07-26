// THE edge test. Everything before this measured the model against my own
// baseline. This measures it against a real, priced market: the corner 3-way
// (which side wins the corner count), FootyStats field odds_corners_1/x/2.
//
//   node src/edge3way.js --data data/matches.json
//
// The favourite-corners signal, if it is worth anything, must beat this line
// after vig. Method:
//   1. walk-forward project the favourite's and underdog's corner means
//      (shrunk = no mismatch, fitted = with mismatch), fully out of sample
//   2. turn the two means into P(fav wins / draw / dog wins) via a negative
//      binomial difference (independence assumed — see caveat below)
//   3. compare to the vig-adjusted market and bet only when edge >= threshold
//   4. settle at the ACTUAL offered odds and report ROI with a t-stat
//
// A positive log-loss gain over my baseline (which we have) does NOT imply
// positive ROI here. If the book already prices favourite dominance, model and
// market agree, no bet clears the threshold, and ROI is ~0. That is the honest
// null, and it is the most likely outcome. Only a positive, significant ROI —
// especially one that survives on the FITTED model but not the SHRUNK one — is
// evidence of real edge.

import { readFileSync } from 'node:fs';
import { runBacktest } from './backtest.js';
import { negBinPmf, wilson, mean } from './stats.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DATA = arg('data', 'data/matches.json');

const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
const rule = (n = 78) => console.log('-'.repeat(n));
const pctS = x => `${(x * 100).toFixed(1)}%`;

const MAXK = 30;
const pmfVec = (mu, r) => {
  const v = new Array(MAXK + 1);
  let s = 0;
  for (let k = 0; k <= MAXK; k++) { v[k] = negBinPmf(k, mu, r); s += v[k]; }
  for (let k = 0; k <= MAXK; k++) v[k] /= s; // renormalise the truncated tail
  return v;
};

// P(fav > dog), P(fav == dog), P(fav < dog) for independent NB counts.
function threeWay(muFav, muDog, rFav, rDog) {
  const f = pmfVec(muFav, rFav), g = pmfVec(muDog, rDog);
  let win = 0, draw = 0;
  for (let i = 0; i <= MAXK; i++) {
    draw += f[i] * g[i];
    let gl = 0;
    for (let j = 0; j < i; j++) gl += g[j];
    win += f[i] * gl;
  }
  return { win, draw, loss: 1 - win - draw };
}

// Vig-adjust the market to fair probabilities, oriented to the favourite.
function fairMarket(c3) {
  const rF = 1 / c3.fav, rO = 1 / c3.dog, rD = c3.draw ? 1 / c3.draw : 0;
  const s = rF + rD + rO;
  return { win: rF / s, draw: rD / s, loss: rO / s, overround: s - 1 };
}

// Settle a 1-unit bet on the favourite winning the corner count.
const settleFavWin = (row, odds) => (row.actualFav > row.actualDog ? odds - 1 : -1);
const settleDogWin = (row, odds) => (row.actualDog > row.actualFav ? odds - 1 : -1);

function betReport(title, bets) {
  console.log(`\n${title}`);
  rule();
  if (!bets.length) { console.log('  no fixtures with a priced corner 3-way market.'); return; }
  console.log(pad('edge >=', 10) + pad('bets', 8, true) + pad('hit rate', 11, true) + pad('avg odds', 10, true) + pad('ROI', 10, true) + pad('t-stat', 9, true) + '   verdict');
  for (const thr of [0.00, 0.02, 0.03, 0.05]) {
    const sel = bets.filter(b => b.edge >= thr);
    if (sel.length < 20) { console.log(pad(`+${(thr * 100).toFixed(0)}pt`, 10) + pad(sel.length, 8, true) + '   (thin)'); continue; }
    const rets = sel.map(b => b.ret);
    const roi = mean(rets);
    const sd = Math.sqrt(mean(rets.map(x => (x - roi) ** 2)));
    const t = roi / (sd / Math.sqrt(sel.length));
    const hits = sel.filter(b => b.ret > 0).length;
    const [lo, hi] = wilson(hits, sel.length);
    const verdict = t > 2 ? 'PROFITABLE (p<.05)' : t > 1 ? 'weak +' : Math.abs(t) <= 1 ? 'no edge' : 'LOSING';
    console.log(
      pad(`+${(thr * 100).toFixed(0)}pt`, 10) + pad(sel.length, 8, true) +
      pad(pctS(hits / sel.length), 11, true) + pad((sel.reduce((s, b) => s + b.odds, 0) / sel.length).toFixed(2), 10, true) +
      pad((roi >= 0 ? '+' : '') + pctS(roi), 10, true) + pad(t.toFixed(2), 9, true) + '   ' + verdict +
      (t > 2 ? '' : `  (hit CI ${pctS(lo)}-${pctS(hi)})`),
    );
  }
}

const matches = JSON.parse(readFileSync(DATA, 'utf8'));

// Fav and dog runs filter identically (favIsHome != null) and preserve order,
// so their predictions align index-for-index.
const favRes = runBacktest(matches, { line: 5.5, target: 'fav' });
const dogRes = runBacktest(matches, { line: 5.5, target: 'dog' });
if (favRes.error) { console.error('ERROR: ' + favRes.error); process.exit(1); }
if (favRes.preds.length !== dogRes.preds.length) {
  console.error('fav/dog prediction sets misaligned — aborting.'); process.exit(1);
}

const rFav = favRes.disp, rDog = dogRes.disp;
console.log(`\nCORNER 3-WAY EDGE TEST  (${favRes.preds.length} out-of-sample fixtures)`);
console.log(`negative-binomial dispersion: fav r=${isFinite(rFav) ? rFav.toFixed(1) : 'Poisson'}, dog r=${isFinite(rDog) ? rDog.toFixed(1) : 'Poisson'}`);

const priced = [];
for (let i = 0; i < favRes.preds.length; i++) {
  const row = favRes.preds[i].row;
  if (!row.corner3 || !(row.corner3.fav > 1) || !(row.corner3.dog > 1)) continue;
  priced.push({ i, row, c3: row.corner3 });
}
console.log(`priced corner 3-way markets: ${priced.length} of ${favRes.preds.length}`);
if (priced.length) {
  const mkt = priced.map(p => fairMarket(p.c3));
  console.log(`mean overround: ${pctS(mean(mkt.map(m => m.overround)))}`);
}

for (const [label, key] of [['SHRUNK model (no mismatch term)', 'shr'], ['FITTED model (with mismatch term)', 'fitd']]) {
  const favBets = [], dogBets = [];
  for (const p of priced) {
    const muFav = favRes.preds[p.i][key], muDog = dogRes.preds[p.i][key];
    const model = threeWay(muFav, muDog, rFav, rDog);
    const fair = fairMarket(p.c3);
    favBets.push({ edge: model.win - fair.win, odds: p.c3.fav, ret: settleFavWin(p.row, p.c3.fav) });
    dogBets.push({ edge: model.loss - fair.loss, odds: p.c3.dog, ret: settleDogWin(p.row, p.c3.dog) });
  }
  betReport(`${label} — betting the FAVOURITE to win corners`, favBets);
  betReport(`${label} — betting the UNDERDOG to win corners`, dogBets);
}

console.log('\nCAVEATS');
rule();
console.log('- Independence between the two sides’ corner counts is assumed. Corners are');
console.log('  mildly positively correlated in reality, which slightly overstates P(draw)');
console.log('  and understates both win probabilities. Treat small edges with suspicion.');
console.log('- Odds are FootyStats’ settled prices, not the price you would have gotten at');
console.log('  bet time; real CLV requires timestamped lines. This is the optimistic case.');
console.log('- A t-stat > 2 on ONE threshold is not proof. Look for ROI that rises with the');
console.log('  edge filter and holds on fitted but not shrunk. One lucky cell is noise.');
