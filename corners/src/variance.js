// The predictability CEILING for corners — why two independent projections
// both scored ~zero, and the most any pre-game model could ever achieve.
//
//   node src/variance.js --data data/matches.json
//
// Corner counts behave like a (mixed) Poisson process: a per-match scoring
// RATE, plus irreducible in-game randomness around it. Only the variation in
// the RATE is predictable — the Poisson noise never is, by any model, ever.
//
//   Var(actual) = E[rate]        (irreducible Poisson noise)
//               + Var(rate)      (the ONLY predictable part)
//
// So the maximum variance any pre-game model can explain is Var(rate)/Var(actual),
// and the maximum correlation it can reach is the square root of that — even
// with a perfect model that knows each match's true rate. This puts a hard
// number on "can we predict corners per game".

import { readFileSync } from 'node:fs';
import { mean } from './stats.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DATA = arg('data', 'data/matches.json');

const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
const rule = (n = 78) => console.log('-'.repeat(n));
const variance = a => { const m = mean(a); return mean(a.map(x => (x - m) ** 2)); };

function decompose(label, values) {
  const n = values.length;
  if (n < 100) return null;
  const m = mean(values);
  const V = variance(values);
  const rateVar = Math.max(0, V - m);        // Var(rate) = Var(X) - E[X] for mixed Poisson
  const maxR2 = rateVar / V;                  // ceiling on explained variance
  const maxR = Math.sqrt(maxR2);              // ceiling on correlation
  const poissonSD = Math.sqrt(m);
  const rateSD = Math.sqrt(rateVar);
  return { label, n, m, sd: Math.sqrt(V), poissonSD, rateSD, maxR2, maxR };
}

const raw = JSON.parse(readFileSync(DATA, 'utf8'));
const rows = raw.filter(m => Number.isFinite(m.hc) && Number.isFinite(m.ac));

const targets = [
  ['match total', rows.map(m => m.hc + m.ac)],
  ['home corners', rows.map(m => m.hc)],
  ['away corners', rows.map(m => m.ac)],
];
const fh = rows.filter(m => Number.isFinite(m.fhHc) && Number.isFinite(m.fhAc));
if (fh.length >= 100) targets.push(['first-half total', fh.map(m => m.fhHc + m.fhAc)]);

console.log(`\nCORNER PREDICTABILITY CEILING  (${rows.length} matches)`);
console.log('how much of each quantity is EVEN IN PRINCIPLE predictable pre-game?\n');
console.log(pad('quantity', 18) + pad('n', 7, true) + pad('mean', 8, true) + pad('SD', 8, true) +
  pad('Poisson SD', 12, true) + pad('rate SD', 10, true) + pad('max R', 8, true) + pad('max R²', 9, true));
rule();
for (const [label, vals] of targets) {
  const d = decompose(label, vals);
  if (!d) continue;
  console.log(
    pad(d.label, 18) + pad(d.n, 7, true) + pad(d.m.toFixed(2), 8, true) + pad(d.sd.toFixed(2), 8, true) +
    pad(d.poissonSD.toFixed(2), 12, true) + pad(d.rateSD.toFixed(2), 10, true) +
    pad(d.maxR.toFixed(2), 8, true) + pad(`${(d.maxR2 * 100).toFixed(0)}%`, 9, true),
  );
}

console.log('\nHOW TO READ THIS');
rule();
console.log('- "Poisson SD" is the irreducible per-match noise. No model removes it.');
console.log('- "rate SD" is how much the true underlying rate varies match to match —');
console.log('  the entire predictable signal, in corners.');
console.log('- "max R" is the CEILING correlation any pre-game model could reach, even a');
console.log('  perfect one. FootyStats got r=0.04 and a point-in-time model ~0 — both far');
console.log('  below even this ceiling, because the rate variation that DOES exist is driven');
console.log('  by in-game events (game state, red cards, chasing a deficit), not by anything');
console.log('  knowable at kickoff.');
console.log('');
console.log('The takeaway is not "we built a bad model". It is that corner totals are close');
console.log('to a fixed-rate Poisson process: the mean is stable and knowable, the per-game');
console.log('number is mostly coin-flips around it. Compare the split targets — if "home"/');
console.log('"away" carry more predictable rate variation than the total, that is where the');
console.log('only real signal lives (it cancels in the sum), matching the earlier findings.');
