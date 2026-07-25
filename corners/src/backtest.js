// Walk-forward backtest. Answers one question: is there a pre-kickoff pattern
// in corners that beats the naive rate average — and is your sample big enough
// to prove it?
//
//   node src/backtest.js --data data/matches.json [--line 10.5] [--window 10]
//
// Coefficients are fitted only on rows strictly older than the row being
// predicted, refit every --refit rows. Nothing is fitted on the full sample.

import { readFileSync } from 'node:fs';
import { buildDataset } from './dataset.js';
import { fit, fitShrink, predictFitted, predictShrunk, predictRaw, predictNull, overProbability, edgeVsMarket } from './model.js';
import { mae, rmse, mean, logLoss, wilson, estimateDispersion } from './stats.js';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DATA = arg('data', 'data/matches.json');
const LINE = parseFloat(arg('line', '10.5'));
const MIN_TRAIN = parseInt(arg('minTrain', '400'), 10);
const REFIT = parseInt(arg('refit', '100'), 10);

const pct = x => `${(x * 100).toFixed(1)}%`;
const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
const rule = (n = 74) => console.log('-'.repeat(n));

export function runBacktest(matches, opts = {}) {
  const line = opts.line ?? LINE;
  const rows = buildDataset(matches, opts);

  if (rows.length < MIN_TRAIN + 50) {
    return { error: `Only ${rows.length} usable rows after burn-in; need >= ${MIN_TRAIN + 50}.`, rows };
  }

  // ---- walk-forward prediction -------------------------------------------
  const preds = [];
  let coef = null, coefS = null;
  for (let i = MIN_TRAIN; i < rows.length; i++) {
    if ((i - MIN_TRAIN) % REFIT === 0) {
      const train = rows.slice(0, i);
      coefS = fitShrink(train);
      coef = fit(train);
    }
    const r = rows[i];
    preds.push({
      row: r,
      nul: predictNull(r),
      raw: predictRaw(r),
      shr: predictShrunk(r, coefS),
      fitd: predictFitted(r, coef),
    });
  }

  const actual = preds.map(p => p.row.actual);
  const over = actual.map(a => (a > line ? 1 : 0));

  // Dispersion from the first half of predictions, applied to the whole set,
  // so the probability model is not calibrated on its own test data.
  const half = Math.floor(preds.length / 2);
  const disp = estimateDispersion(
    preds.slice(0, half).map(p => p.row.actual),
    preds.slice(0, half).map(p => p.shr),
  );

  const probs = {
    nul: preds.map(p => overProbability(p.nul, line, disp)),
    shr: preds.map(p => overProbability(p.shr, line, disp)),
    fitd: preds.map(p => overProbability(p.fitd, line, disp)),
  };

  return { rows, preds, actual, over, disp, probs, line, coef, coefS };
}

// ---- reporting ------------------------------------------------------------

function reportAccuracy(res) {
  const { preds, actual } = res;
  const cols = [
    ['null (league mean)', preds.map(p => p.nul)],
    ['raw (unshrunk rates)', preds.map(p => p.raw)],
    ['shrunk (book-equivalent)', preds.map(p => p.shr)],
    ['fitted (+ mismatch)', preds.map(p => p.fitd)],
  ];
  console.log('\nPROJECTION ACCURACY  (lower is better)');
  rule();
  console.log(pad('model', 27) + pad('MAE', 10, true) + pad('RMSE', 10, true) + pad('vs null', 12, true));
  const nullMae = mae(actual, cols[0][1]);
  for (const [name, p] of cols) {
    const m = mae(actual, p);
    const improve = ((nullMae - m) / nullMae) * 100;
    console.log(
      pad(name, 27) + pad(m.toFixed(3), 10, true) + pad(rmse(actual, p).toFixed(3), 10, true) +
      pad(name.startsWith('null') ? '-' : `${improve >= 0 ? '+' : ''}${improve.toFixed(1)}%`, 12, true),
    );
  }
}

function reportProbabilistic(res) {
  const { over, probs, disp, line } = res;
  console.log(`\nOVER ${line} AS A PROBABILITY  (log-loss, lower is better)`);
  rule();
  console.log(pad('model', 27) + pad('log-loss', 12, true));
  for (const k of ['nul', 'shr', 'fitd']) {
    const label = { nul: 'null (league mean)', shr: 'shrunk (book-equivalent)', fitd: 'fitted (+ mismatch)' }[k];
    console.log(pad(label, 27) + pad(logLoss(over, probs[k]).toFixed(4), 12, true));
  }
  console.log(`\nbase rate over ${line}: ${pct(mean(over))}   |   NB dispersion r = ${isFinite(disp) ? disp.toFixed(1) : 'Poisson (no overdispersion)'}`);
}

function reportCalibration(res) {
  const { over, probs } = res;
  const p = probs.fitd;
  const buckets = new Map();
  for (let i = 0; i < p.length; i++) {
    const b = Math.min(9, Math.floor(p[i] * 10));
    if (!buckets.has(b)) buckets.set(b, { n: 0, hits: 0, sum: 0 });
    const e = buckets.get(b);
    e.n++; e.hits += over[i]; e.sum += p[i];
  }
  console.log('\nCALIBRATION  (fitted model — predicted vs actual)');
  rule();
  console.log(pad('bucket', 12) + pad('n', 7, true) + pad('predicted', 12, true) + pad('actual', 10, true) + pad('95% CI', 18, true));
  for (const b of [...buckets.keys()].sort((a, z) => a - z)) {
    const e = buckets.get(b);
    const [lo, hi] = wilson(e.hits, e.n);
    const flag = e.n < 30 ? '  (thin)' : '';
    console.log(
      pad(`${b * 10}-${b * 10 + 10}%`, 12) + pad(e.n, 7, true) +
      pad(pct(e.sum / e.n), 12, true) + pad(pct(e.hits / e.n), 10, true) +
      pad(`${pct(lo)}-${pct(hi)}`, 18, true) + flag,
    );
  }
}

// Binary signal grid, in the house style of the existing 4-signal FHS model —
// so a positive result can drop straight into the site.
const SIGNALS = [
  { key: 'CB', label: 'Baseline projection high', test: r => r.baseline >= 11.0, desc: 'rate-paired projection >= 11.0' },
  { key: 'MM', label: 'Clear favourite', test: r => (r.mismatch ?? 0) >= 0.40, desc: 'no-vig |P(home)-P(away)| >= 0.40' },
  { key: 'BL', label: 'Both defences leak corners', test: r => r.blockiness >= 1.05, desc: 'mean corners-against >= 1.05x league' },
  { key: 'AT', label: 'Both attacks win corners', test: r => r.hCF >= r.lgHC && r.aCF >= r.lgAC, desc: 'both corners-for above their venue league avg' },
];

function reportSignalGrid(res) {
  const { preds, over, line } = res;
  const cells = new Map();
  for (let i = 0; i < preds.length; i++) {
    const r = preds[i].row;
    const n = SIGNALS.filter(s => s.test(r)).length;
    if (!cells.has(n)) cells.set(n, { n: 0, hits: 0 });
    const e = cells.get(n);
    e.n++; e.hits += over[i];
  }
  const baseRate = mean(over);
  console.log(`\nSIGNAL GRID  (site-style: signals met -> hit rate for over ${line})`);
  rule();
  console.log(pad('signals', 10) + pad('n', 8, true) + pad('hit rate', 12, true) + pad('lift', 9, true) + pad('95% CI', 18, true));
  for (const k of [...cells.keys()].sort((a, z) => a - z)) {
    const e = cells.get(k);
    const hr = e.hits / e.n;
    const [lo, hi] = wilson(e.hits, e.n);
    const thin = e.n < 50 ? '  (thin - do not ship)' : '';
    console.log(
      pad(`${k}/4`, 10) + pad(e.n, 8, true) + pad(pct(hr), 12, true) +
      pad(`${(hr / baseRate).toFixed(2)}x`, 9, true) + pad(`${pct(lo)}-${pct(hi)}`, 18, true) + thin,
    );
  }
  console.log('\nsignal definitions:');
  for (const s of SIGNALS) console.log(`  ${pad(s.key, 4)} ${pad(s.label, 30)} ${s.desc}`);
}

function reportEdge(res) {
  const { preds, over, probs } = res;
  const withOdds = [];
  for (let i = 0; i < preds.length; i++) {
    const o = preds[i].row.cornerOdds;
    if (!o) continue;
    const e = edgeVsMarket(probs.fitd[i], o.over, o.under);
    if (e) withOdds.push({ e, hit: over[i] });
  }
  console.log('\nEDGE VS MARKET');
  rule();
  if (!withOdds.length) {
    console.log('No corner-market prices in the dataset — edge is UNMEASURABLE.');
    console.log('MAE and calibration tell you the model is accurate, not that it is profitable.');
    console.log('Add {cornerOdds:{over,under}} per match (line ' + res.line + ') to turn this on.');
    return;
  }
  const bets = withOdds.filter(w => w.e.edgeOver >= 2);
  const hits = bets.filter(w => w.hit).length;
  const [lo, hi] = wilson(hits, bets.length);
  console.log(`priced fixtures: ${withOdds.length}   mean overround: ${pct(mean(withOdds.map(w => w.e.overround)))}`);
  console.log(`bets at >= 2pt edge on the over: ${bets.length}`);
  if (bets.length) console.log(`hit rate: ${pct(hits / bets.length)}  (95% CI ${pct(lo)}-${pct(hi)})`);
}

function reportPower(res) {
  const n = res.preds.length;
  // Bets needed to distinguish a given edge from breakeven at ~2:1 odds, 95%/80%.
  console.log('\nSTATISTICAL POWER  (can this sample prove anything?)');
  rule();
  console.log(`evaluated fixtures: ${n}  |  burn-in discarded: ${res.rows.skippedBurnIn}`);
  for (const edge of [0.02, 0.03, 0.05, 0.08]) {
    const p0 = 0.5, p1 = 0.5 + edge;
    const need = Math.ceil(((1.96 * Math.sqrt(p0 * (1 - p0)) + 0.84 * Math.sqrt(p1 * (1 - p1))) ** 2) / (edge * edge));
    const ok = n >= need ? 'yes' : 'NO';
    console.log(`  ${pad(`${(edge * 100).toFixed(0)}pt edge`, 14)} needs ~${pad(need, 6, true)} bets   detectable here: ${ok}`);
  }
}

export function summarise(res) {
  const { preds, actual, over, probs } = res;
  const nullMae = mae(actual, preds.map(p => p.nul));
  const shrMae = mae(actual, preds.map(p => p.shr));
  const fitMae = mae(actual, preds.map(p => p.fitd));
  return {
    n: preds.length,
    shrVsNull: ((nullMae - shrMae) / nullMae) * 100,
    fitVsShr: ((shrMae - fitMae) / shrMae) * 100,
    llShr: logLoss(over, probs.shr),
    llFit: logLoss(over, probs.fitd),
  };
}

function verdict(res) {
  const s = summarise(res);
  const shrinkCoef = res.coefS ? res.coefS[1] : null;

  console.log('\nVERDICT');
  rule();
  console.log(
    `Is there a pre-kickoff pattern at all?   ` +
    (s.shrVsNull > 0.5
      ? `YES - team rates beat the league mean by ${s.shrVsNull.toFixed(2)}% MAE`
      : `NO - team corner rates do not beat a constant`),
  );
  console.log(
    `Does anything beat the book's own model?  ` +
    (s.fitVsShr > 1 && s.llFit < s.llShr
      ? `YES - mismatch terms add ${s.fitVsShr.toFixed(2)}% MAE and improve log-loss`
      : `NO - mismatch/style terms add nothing out of sample`),
  );
  if (shrinkCoef !== null) {
    console.log(`\nregression-to-mean coefficient on the rate projection: ${shrinkCoef.toFixed(3)}`);
    console.log(shrinkCoef < 0.75
      ? `  (below 1 — roughly ${((1 - shrinkCoef) * 100).toFixed(0)}% of the spread in a rolling corner rate is\n   estimation noise, so the projection must be pulled back toward the league mean)`
      : '  (close to 1 — team corner rates carry real, persistent information)');
  }
  console.log('');
  console.log("Read this carefully: beating the league mean is NOT edge. The book prices");
  console.log('corners off the same rate pairing. Only the second line above is evidence');
  console.log('of something the market has not already priced in.');
}

export function printReport(res) {
  if (res.error) { console.error('ERROR: ' + res.error); process.exitCode = 1; return; }
  reportAccuracy(res);
  reportProbabilistic(res);
  reportCalibration(res);
  reportSignalGrid(res);
  reportEdge(res);
  reportPower(res);
  verdict(res);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let matches;
  try {
    matches = JSON.parse(readFileSync(DATA, 'utf8'));
  } catch (e) {
    console.error(`Could not read ${DATA}: ${e.message}`);
    console.error('Run `node src/fetch.js` first, or pass --data <path>.');
    process.exit(1);
  }
  console.log(`\nCORNERS BACKTEST — ${matches.length} raw matches, line ${LINE}`);
  printReport(runBacktest(matches, {
    line: LINE,
    window: parseInt(arg('window', '10'), 10),
    minPrior: parseInt(arg('minPrior', '6'), 10),
    shrink: parseFloat(arg('shrink', '5')),
  }));
}
