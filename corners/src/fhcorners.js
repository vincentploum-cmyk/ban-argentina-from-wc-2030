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
import { fitRatings, ratingProjection } from './ratings.js';

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
// Emit TWO observations per match — one per attacking side. Predicting each
// team's own FH corners is where the shots signal lives (A and B are team-level);
// the match total cancels it. target = that side's FH corners; features = that
// side's attacking volume vs the opponent's defensive volume, all point-in-time.
for (const m of raw) {
  const ht = tstate(m.home), at = tstate(m.away);
  const L = lg.get(m.league) ?? { fhTeam: [], cFor: [], sFor: [], hist: [], ratC: null, ratDA: null, fitAt: -1 };
  const haveShots = m.shots && Number.isFinite(m.shots.h) && Number.isFinite(m.shots.a);
  const haveSot = m.sot && Number.isFinite(m.sot.h) && Number.isFinite(m.sot.a);
  const haveFH = Number.isFinite(m.fhHc) && Number.isFinite(m.fhAc);

  const enough = ht.home.length >= MIN_PRIOR && at.away.length >= MIN_PRIOR && L.cFor.length >= 60;
  if (enough && haveFH) {
    const hH = tail(ht.home, WINDOW), aA = tail(at.away, WINDOW);
    const lgCFor = mean(tail(L.cFor, 400)), lgSFor = mean(tail(L.sFor, 400)), lgFHteam = mean(tail(L.fhTeam, 400));

    // Refit opponent-adjusted ratings periodically from ALL prior matches in
    // this league (time-decayed). Strictly point-in-time: L.hist only ever
    // contains matches already played.
    if (L.hist.length >= 40 && L.hist.length - L.fitAt >= 60) {
      L.ratC = fitRatings(L.hist.map(g => ({ date: g.date, home: g.home, away: g.away, hv: g.hc, av: g.ac })), m.date);
      L.ratDA = fitRatings(L.hist.filter(g => g.dah != null).map(g => ({ date: g.date, home: g.home, away: g.away, hv: g.dah, av: g.daa })), m.date);
      L.fitAt = L.hist.length;
    }

    // one attacker's projection: own attacking rate blended with opp conceding rate
    const side = (atkRoll, defRoll, target, atkName, defName, isHome) => {
      const aS = atkRoll.filter(x => x.sf !== null), dS = defRoll.filter(x => x.sf !== null);
      if (aS.length < MIN_PRIOR || dS.length < MIN_PRIOR) return null;
      // Generic for/against blend for any volume metric, null when uncovered.
      const blend = (fk, ak, prior) => {
        const af = atkRoll.filter(x => x[fk] != null), df = defRoll.filter(x => x[ak] != null);
        if (af.length < MIN_PRIOR || df.length < MIN_PRIOR) return null;
        return shrunk(af.map(x => x[fk]), prior, SHRINK) + shrunk(df.map(x => x[ak]), prior, SHRINK);
      };
      return {
        date: m.date, target, lgFHteam,
        cProj: shrunk(atkRoll.map(x => x.cf), lgCFor, SHRINK) + shrunk(defRoll.map(x => x.ca), lgCFor, SHRINK),
        sProj: shrunk(aS.map(x => x.sf), lgSFor, SHRINK) + shrunk(dS.map(x => x.sa), lgSFor, SHRINK),
        sotProj: blend('sotf', 'sota', lgSFor / 3),
        daProj: blend('daf', 'daa', 40),      // dangerous attacks ~40/team/match
        atkProj: blend('atkf', 'atka', 100),  // attacks ~100/team/match
        possProj: blend('possf', 'possa', 50),
        // opponent-adjusted ratings — same data, far less estimation noise
        ratCProj: ratingProjection(L.ratC, atkName, defName, isHome),
        ratDAProj: ratingProjection(L.ratDA, atkName, defName, isHome),
      };
    };
    const homeAtk = side(hH, aA, m.fhHc, m.home, m.away, true);
    const awayAtk = side(aA, hH, m.fhAc, m.away, m.home, false);
    if (homeAtk) rows.push(homeAtk);
    if (awayAtk) rows.push(awayAtk);
  }

  // update state AFTER emitting
  const g = (o, side) => (o && Number.isFinite(o[side]) ? o[side] : null);
  ht.home.push({
    cf: m.hc, ca: m.ac,
    sf: haveShots ? m.shots.h : null, sa: haveShots ? m.shots.a : null,
    sotf: haveSot ? m.sot.h : null, sota: haveSot ? m.sot.a : null,
    daf: g(m.dangAtt, 'h'), daa: g(m.dangAtt, 'a'),
    atkf: g(m.attacks, 'h'), atka: g(m.attacks, 'a'),
    possf: g(m.poss, 'h'), possa: g(m.poss, 'a'),
  });
  at.away.push({
    cf: m.ac, ca: m.hc,
    sf: haveShots ? m.shots.a : null, sa: haveShots ? m.shots.h : null,
    sotf: haveSot ? m.sot.a : null, sota: haveSot ? m.sot.h : null,
    daf: g(m.dangAtt, 'a'), daa: g(m.dangAtt, 'h'),
    atkf: g(m.attacks, 'a'), atka: g(m.attacks, 'h'),
    possf: g(m.poss, 'a'), possa: g(m.poss, 'h'),
  });
  L.hist.push({ date: m.date, home: m.home, away: m.away, hc: m.hc, ac: m.ac, dah: g(m.dangAtt, 'h'), daa: g(m.dangAtt, 'a') });
  if (haveFH) { L.fhTeam.push(m.fhHc); L.fhTeam.push(m.fhAc); }
  L.cFor.push(m.hc); L.cFor.push(m.ac);
  if (haveShots) { L.sFor.push(m.shots.h); L.sFor.push(m.shots.a); }
  lg.set(m.league, L);
}

// Require shot features so every model is compared on identical fixtures —
// feature deltas must not be sample artifacts.
const usable = rows.filter(r => r.sProj !== null);
console.log('\nC) WALK-FORWARD PREDICTION OF PER-TEAM FIRST-HALF CORNERS');
rule();
console.log('target: one team\'s own first-half corners (2 obs/match). This is where the');
console.log('team-level signal from A/B lives — the match total cancels it out.');
if (usable.length < MIN_TRAIN + 50) {
  console.log(`\nOnly ${usable.length} observations have shot features — need >= ${MIN_TRAIN + 50}.`);
} else {
  const covered = key => usable.filter(r => r[key] !== null && r[key] !== undefined).length > usable.length * 0.8;
  const has = { sot: covered('sotProj'), da: covered('daProj'), atk: covered('atkProj'), poss: covered('possProj') };
  console.log('\nfeature coverage: ' + Object.entries(has).map(([k, v]) => `${k}=${v ? 'yes' : 'NO'}`).join('  '));

  // Each volume metric tested alone and on top of corner form. Territorial
  // metrics (dangerous attacks, attacks, possession) are the untested ones —
  // they separate dominant from dominated sides harder than corners do.
  const designs = {
    null: () => [1],
    corners: r => [1, r.cProj],
    shots: r => [1, r.sProj],
    'corners+shots': r => [1, r.cProj, r.sProj],
  };
  if (has.sot) { designs.sot = r => [1, r.sotProj]; designs['corners+sot'] = r => [1, r.cProj, r.sotProj]; }
  if (has.da) { designs.dangAtt = r => [1, r.daProj]; designs['corners+dangAtt'] = r => [1, r.cProj, r.daProj]; }
  if (has.atk) { designs.attacks = r => [1, r.atkProj]; designs['corners+attacks'] = r => [1, r.cProj, r.atkProj]; }
  if (has.poss) designs['corners+poss'] = r => [1, r.cProj, r.possProj];
  // Ratings: opponent-adjusted, all-history, time-decayed — the low-noise
  // replacement for rolling averages. This is the key comparison.
  if (covered('ratCProj')) {
    designs['RATINGS corners'] = r => [1, r.ratCProj];
    if (covered('ratDAProj')) {
      designs['RATINGS dangAtt'] = r => [1, r.ratDAProj];
      designs['RATINGS both'] = r => [1, r.ratCProj, r.ratDAProj];
      designs['RATINGS + rolling'] = r => [1, r.ratCProj, r.ratDAProj, r.cProj, r.daProj ?? 0];
    }
  }
  // kitchen sink: everything covered, together
  designs['ALL covered'] = r => [1, r.cProj, r.sProj]
    .concat(has.sot ? [r.sotProj] : []).concat(has.da ? [r.daProj] : [])
    .concat(has.atk ? [r.atkProj] : []).concat(has.poss ? [r.possProj] : []);
  const keys = Object.keys(designs);
  const preds = Object.fromEntries(keys.map(k => [k, []]));
  const actual = [];
  const coefs = {};
  for (let i = MIN_TRAIN; i < usable.length; i++) {
    if ((i - MIN_TRAIN) % REFIT === 0) {
      const train = usable.slice(0, i);
      for (const k of keys) coefs[k] = fitOLS(train.map(designs[k]), train.map(r => r.target), 1e-4);
    }
    const r = usable[i];
    actual.push(r.target);
    for (const k of keys) {
      const x = designs[k](r); let mu = 0; const c = coefs[k];
      for (let j = 0; j < c.length; j++) mu += c[j] * x[j];
      preds[k].push(isFinite(mu) && mu > 0 && mu < 10 ? mu : r.lgFHteam);
    }
  }
  console.log('\n' + pad('feature set', 16) + pad('MAE', 10, true) + pad('RMSE', 10, true) + pad('corr', 9, true) + pad('vs null (MAE)', 15, true));
  const nMae = mae(actual, preds.null);
  for (const k of keys) {
    const m = mae(actual, preds[k]);
    const gain = ((nMae - m) / nMae) * 100;
    console.log(
      pad(k, 16) + pad(m.toFixed(3), 10, true) + pad(rmse(actual, preds[k]).toFixed(3), 10, true) +
      pad(pearson(actual, preds[k]).toFixed(3), 9, true) +
      pad(k === 'null' ? '-' : `${gain >= 0 ? '+' : ''}${gain.toFixed(2)}%`, 15, true),
    );
  }
  console.log(`\nevaluated ${actual.length} team-observations, mean per-team FH corners ${mean(actual).toFixed(2)}`);

  // ---- D. ceiling for per-team FH corners --------------------------------
  const mm = mean(actual);
  const V = mean(actual.map(x => (x - mm) ** 2));
  const rateVar = Math.max(0, V - mm);
  console.log('\nD) PER-TEAM FH-CORNER PREDICTABILITY CEILING');
  rule();
  console.log(`mean ${mm.toFixed(2)}, variance ${V.toFixed(2)}, Poisson floor ${mm.toFixed(2)}`);
  console.log(`max explainable R^2 = ${(rateVar / V * 100).toFixed(0)}%   ->   max correlation r = ${Math.sqrt(rateVar / V).toFixed(2)}`);
  console.log('  judge the "corr" column against this ceiling, not against 1.0.');
}

console.log('\nWHAT A WIN LOOKS LIKE');
rule();
console.log('- B: shots more reliable than corners (they should be — higher volume).');
console.log('- C: "shots" beats "corners" on corr/MAE, "both" or "shots+sot" best. If so,');
console.log('  your thesis holds: shot history predicts FH corners better than corner history.');
console.log('- All of C judged against the D ceiling. Beating the mean here at all is more');
console.log('  would already be more than the match total ever managed.');
