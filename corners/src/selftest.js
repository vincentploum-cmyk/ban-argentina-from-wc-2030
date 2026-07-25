// Harness validation. Three worlds with known answers:
//
//   A  pure noise           -> nothing should beat the league mean
//   B  team rates, no extra -> baseline should beat the mean; fitted should NOT
//                              meaningfully beat baseline
//   C  planted mismatch     -> fitted SHOULD beat baseline
//
// If any of these fail, the verdict this harness prints on real data is not
// trustworthy and should not be acted on.

import { generate } from './synthetic.js';
import { runBacktest, summarise } from './backtest.js';

const worlds = [
  { id: 'A', label: 'pure noise (no team effect)', opts: { noise: true, seed: 7 } },
  { id: 'B', label: 'team rates only', opts: { mismatchBeta: 0, seed: 11 } },
  { id: 'C', label: 'team rates + planted mismatch', opts: { mismatchBeta: 0.35, seed: 11 } },
];

const results = {};
console.log('HARNESS SELF-TEST\n' + '='.repeat(78));

for (const w of worlds) {
  // 4 leagues x 20 teams x 2 double round-robins ~ 3000 matches, so each world
  // is evaluated on a sample comparable to the real one.
  const matches = generate({ teams: 20, leagues: 4, rounds: 2, ...w.opts });
  const res = runBacktest(matches, { line: 10.5 });
  if (res.error) { console.error(`world ${w.id}: ${res.error}`); process.exit(1); }
  const g = summarise(res);
  g.shrinkCoef = res.coefS ? res.coefS[1] : NaN;
  results[w.id] = g;
  console.log(
    `world ${w.id}  ${w.label.padEnd(32)} n=${String(g.n).padStart(5)}  ` +
    `shrunk-vs-null ${g.shrVsNull >= 0 ? '+' : ''}${g.shrVsNull.toFixed(2)}%  ` +
    `fit-vs-shrunk ${g.fitVsShr >= 0 ? '+' : ''}${g.fitVsShr.toFixed(2)}%  ` +
    `shrink=${g.shrinkCoef.toFixed(2)}`,
  );
}

console.log('\nASSERTIONS\n' + '-'.repeat(78));
const checks = [
  // In a world with no team effect the fitted shrink coefficient must collapse,
  // and neither model may claim a gain.
  ['A: noise -> shrink coefficient collapses toward 0', results.A.shrinkCoef < 0.35],
  ['A: noise -> no phantom team-rate signal', results.A.shrVsNull < 0.5],
  ['A: noise -> no phantom mismatch signal', results.A.fitVsShr < 0.5],
  // Real team rates must be picked up, but the gain is genuinely tiny.
  ['B: real team rates are recovered', results.B.shrVsNull > 0.3],
  ['B: no phantom mismatch signal', results.B.fitVsShr < 0.5],
  // A planted effect must be found on top of the book-equivalent model.
  ['C: planted mismatch is recovered', results.C.fitVsShr > 1.0],
  ['C: recovery also improves log-loss', results.C.llFit < results.C.llShr],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}

console.log('-'.repeat(74));
if (failed) {
  console.log(`${failed} assertion(s) failed — do not trust this harness yet.`);
  process.exit(1);
}
console.log('All assertions passed. The harness detects real signal and rejects noise.');
