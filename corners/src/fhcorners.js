// Tests two specific claims, both on FIRST-HALF corners as the target:
//   1. shots predict corners (a high-shot team earns more corners)
//   2. both teams' pre-game stats matter for the first-half corner outcome
//
//   node src/fhcorners.js --data data/matches.json
//
// Everything is point-in-time: each fixture's features come only from matches
// that finished before it. Four questions, in order:
//
//   A. RELATIONSHIP  — at season level, do high-shot teams get more corners?
//   B. RELIABILITY   — split-half: which pre-game metric is most persistent,
//                      i.e. carries real team signal rather than noise? Shots
//                      should beat corners here — that is the whole thesis.
//   C. PREDICTION    — walk-forward, predict FH corners from rolling SHOTS vs
//                      rolling CORNERS vs BOTH vs the league mean.
//   D. CEILING       — the mixed-Poisson max correlation for FH corners, so a
//                      win is judged against what is achievable, not against 1.0.

import { readFileSync } from 'node:fs';
import { fitOLS, mean, mae, rmse } from './stats.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DATA = arg('data', 'data/matches.json');
const WINDOW = parseInt(arg('window', '12'), 10);
const MIN_PRIOR = parseInt(arg('minPrior', '6'), 10);
const SHRINK = parseFloat(arg('shrink', '4'));
const MIN_TRAIN = parseInt(arg('minTrain', '400'), 10);
const REFIT = parseInt(arg('refit', '100'), 10);

const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
const rule = (n = 76) => console.log('-'.repeat(n));
const tail = (a, n) => (n >= a.length ? a : a.slice(a.length - n));

function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
const shrunk = (vals, prior, k) => (vals.reduce((s, x) => s + x, 0) + k * prior) / (vals.length + k);

// ---- load -----------------------------------------------------------------
const raw = JSON.parse(readFileSync(DATA, 'utf8'))
  .filter(m => Number.isFinite(m.hc) && Number.isFinite(m.ac) && Number.isFinite(m.date))
  .sort((a, b) => a.date - b.date);
const hasFH = raw.filter(m => Number.isFinite(m.fhHc) && Number.isFinite(m.fhAc));
const hasShots = raw.filter(m => m.shots && Number.isFinite(m.shots.h) && Number.isFinite(m.shots.a));

console.log(`\nFIRST-HALF CORNERS FROM SHOTS  (${raw.length} matches; ${hasFH.length} w/ FH corners; ${hasShots.length} w/ shots)`);
if (!hasShots.length) {
  console.error('\nNo shot data present. Re-fetch (fetch.js now captures shots), then retry.');
  console.error('If coverage is still 0, the shot field name differs — dump keys with:');
  console.error(`  curl -s "https://api.football-data-api.com/league-matches?season_id=15050&max_per_page=1&page=1&key=$FOOTYSTATS_KEY" | python3 -c "import sys,json;print(sorted(k for k in json.load(sys.stdin)['data'][0] if 'shot' in k.lower()))"`);
  process.exit(1);
}
if (!hasFH.length) { console.error('No first-half corner data present. Re-fetch and retry.'); process.exit(1); }

// ---- A. season-level relationship: shots vs corners -----------------------
const teamAgg = new Map();
const bump = (name, cf, sf, sotf) => {
  let a = teamAgg.get(name); if (!a) { a = { cf: [], sf: [], sotf: [] }; teamAgg.set(name, a); }
  a.cf.push(cf); a.sf.push(sf); if (sotf !== null) a.sotf.push(sotf);
};
for (const m of hasShots) {
  bump(m.home, m.hc, m.shots.h, m.sot ? m.sot.h : null);
  bump(m.away, m.ac, m.shots.a, m.sot ? m.sot.a : null);
}
const teams = [...teamAgg.values()].filter(a => a.cf.length >= 10);
const tShots = teams.map(a => mean(a.sf));
const tCorners = teams.map(a => mean(a.cf));
const tSot = teams.map(a => (a.sotf.length ? mean(a.sotf) : NaN));
console.log('\nA) SEASON-LEVEL RELATIONSHIP  (do high-shot teams earn more corners?)');
rule();
console.log(`teams: ${teams.length}`);
console.log(`corr(team avg shots, team avg corners)          r = ${pearson(tShots, tCorners).toFixed(3)}`);
if (tSot.every(Number.isFinite)) console.log(`corr(team avg shots-on-target, team avg corners) r = ${pearson(tSot, tCorners).toFixed(3)}`);
console.log('  a strong positive r confirms the shots->corners link at team level.');

// ---- B. split-half reliability -------------------------------------------
// How much does a metric measured in the first half of a team's season carry
// over to the second half? High = real, persistent, useful pre-game.
function splitHalfReliability(metric) {
  const A = [], B = [];
  for (const a of teams) {
    const v = a[metric]; if (v.length < 12) continue;
    const half = Math.floor(v.length / 2);
    A.push(mean(v.slice(0, half))); B.push(mean(v.slice(half)));
  }
  return { r: pearson(A, B), n: A.length };
}
console.log('\nB) SPLIT-HALF RELIABILITY  (which pre-game metric is most persistent?)');
rule();
for (const [label, key] of [['corners for', 'cf'], ['shots for', 'sf'], ['shots on target for', 'sotf']]) {
  const { r, n } = splitHalfReliability(key);
  console.log(`${pad(label, 24)} r = ${r.toFixed(3)}   (n=${n} teams)`);
}
console.log('  higher = the metric reflects a stable team trait, not game-to-game noise.');
console.log('  if shots > corners here, shot history is the better pre-game predictor.');

// ---- C. walk-forward prediction of FH corners -----------------------------
// Build point-in-time venue-rolling features, then compare feature sets.
const st = new Map();
const tstate = n => { let s = st.get(n); if (!s) { s = { home: [], away: [] }; st.set(n, s); } return s; };
const lg = new Map();

const rows = [];
for (const m of raw) {
  const ht = tstate(m.home), at = tstate(m.away);
  const L = lg.get(m.league) ?? { fh: [], c: [], s: [] };
  const haveShots = m.shots && Number.isFinite(m.shots.h) && Number.isFinite(m.shots.a);
  const haveFH = Number.isFinite(m.fhHc) && Number.isFinite(m.fhAc);

  const enough = ht.home.length >= MIN_PRIOR && at.away.length >= MIN_PRIOR && L.c.length >= 30;
  if (enough && haveFH) {
    const hH = tail(ht.home, WINDOW), aA = tail(at.away, WINDOW);
    const lgC = mean(tail(L.c, 200)), lgS = mean(tail(L.s, 200)), lgFH = mean(tail(L.fh, 200));
    const cPrior = lgC / 2, sPrior = lgS / 2;
    // corner-based expected full-match corners
    const cornProj =
      shrunk(hH.map(x => x.cf), cPrior, SHRINK) + shrunk(aA.map(x => x.ca), cPrior, SHRINK) +
      shrunk(aA.map(x => x.cf), cPrior, SHRINK) + shrunk(hH.map(x => x.ca), cPrior, SHRINK);
    // shot-based expected volume (only if this team-history has shots)
    const hHs = hH.filter(x => x.sf !== null), aAs = aA.filter(x => x.sf !== null);
    const haveShotFeat = hHs.length >= MIN_PRIOR && aAs.length >= MIN_PRIOR;
    const shotProj = haveShotFeat
      ? shrunk(hHs.map(x => x.sf), sPrior, SHRINK) + shrunk(aAs.map(x => x.sa), sPrior, SHRINK) +
        shrunk(aAs.map(x => x.sf), sPrior, SHRINK) + shrunk(hHs.map(x => x.sa), sPrior, SHRINK)
      : null;
    rows.push({ date: m.date, cornProj, shotProj, haveShotFeat, lgFH, actual: m.fhHc + m.fhAc });
  }

  // update state AFTER emitting
  ht.home.push({ cf: m.hc, ca: m.ac, sf: haveShots ? m.shots.h : null, sa: haveShots ? m.shots.a : null });
  at.away.push({ cf: m.ac, ca: m.hc, sf: haveShots ? m.shots.a : null, sa: haveShots ? m.shots.h : null });
  L.c.push(m.hc + m.ac); L.s.push(haveShots ? m.shots.h + m.shots.a : mean(tail(L.s, 50)) || 25);
  L.fh.push(haveFH ? m.fhHc + m.fhAc : mean(tail(L.fh, 50)) || 4);
  lg.set(m.league, L);
}

// keep rows with shot features so all models are compared on the SAME fixtures
const usable = rows.filter(r => r.haveShotFeat);
console.log('\nC) WALK-FORWARD PREDICTION OF FIRST-HALF CORNERS');
rule();
if (usable.length < MIN_TRAIN + 50) {
  console.log(`Only ${usable.length} fixtures have both shot features and FH corners — need >= ${MIN_TRAIN + 50}.`);
} else {
  const designs = {
    null: () => [1],
    corners: r => [1, r.cornProj],
    shots: r => [1, r.shotProj],
    both: r => [1, r.cornProj, r.shotProj],
  };
  const preds = { null: [], corners: [], shots: [], both: [] };
  const actual = [];
  const coefs = {};
  for (let i = MIN_TRAIN; i < usable.length; i++) {
    if ((i - MIN_TRAIN) % REFIT === 0) {
      const train = usable.slice(0, i);
      for (const k of Object.keys(designs)) coefs[k] = fitOLS(train.map(designs[k]), train.map(r => r.actual), 1e-4);
    }
    const r = usable[i];
    actual.push(r.actual);
    for (const k of Object.keys(designs)) {
      const x = designs[k](r); let mu = 0; const c = coefs[k];
      for (let j = 0; j < c.length; j++) mu += c[j] * x[j];
      preds[k].push(isFinite(mu) && mu > 0 && mu < 15 ? mu : r.lgFH);
    }
  }
  console.log(pad('feature set', 16) + pad('MAE', 10, true) + pad('RMSE', 10, true) + pad('corr', 9, true) + pad('vs null (MAE)', 15, true));
  const nMae = mae(actual, preds.null);
  for (const k of ['null', 'corners', 'shots', 'both']) {
    const m = mae(actual, preds[k]);
    const gain = ((nMae - m) / nMae) * 100;
    console.log(
      pad(k, 16) + pad(m.toFixed(3), 10, true) + pad(rmse(actual, preds[k]).toFixed(3), 10, true) +
      pad(pearson(actual, preds[k]).toFixed(3), 9, true) +
      pad(k === 'null' ? '-' : `${gain >= 0 ? '+' : ''}${gain.toFixed(2)}%`, 15, true),
    );
  }
  console.log(`\nevaluated ${actual.length} fixtures, mean FH corners ${mean(actual).toFixed(2)}`);

  // ---- D. ceiling for FH corners -----------------------------------------
  const V = mean(actual.map(x => (x - mean(actual)) ** 2));
  const mm = mean(actual);
  const rateVar = Math.max(0, V - mm);
  console.log('\nD) FH-CORNER PREDICTABILITY CEILING');
  rule();
  console.log(`mean ${mm.toFixed(2)}, variance ${V.toFixed(2)}, Poisson floor ${mm.toFixed(2)}`);
  console.log(`max explainable R^2 = ${(rateVar / V * 100).toFixed(0)}%   ->   max correlation r = ${Math.sqrt(rateVar / V).toFixed(2)}`);
  console.log('  judge the "corr" column in C against this ceiling, not against 1.0.');
}

console.log('\nWHAT A WIN LOOKS LIKE');
rule();
console.log('- B: shots more reliable than corners (they should be — higher volume).');
console.log('- C: "shots" beats "corners" on MAE/corr, and "both" is best. If so, your');
console.log('  thesis holds: shot history predicts FH corners better than corner history.');
console.log('- All of C judged against the D ceiling. Beating the mean at all on FH corners');
console.log('  would already be more than the match total ever managed.');
