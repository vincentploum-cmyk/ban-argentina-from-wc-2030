// Corner projections, in ascending order of ambition.
//
//   null     always predict the rolling league mean. The floor.
//   raw      unshrunk attack-index x defence-index projection.
//   shrunk   the same projection with a walk-forward-fitted regression-to-mean
//            coefficient. THIS is the honest comparator: it is what a competent
//            book is doing, and the coefficient on `raw` will come out well
//            below 1 because 10-match corner rates are mostly estimation noise.
//   fitted   shrunk plus mismatch / style terms.
//
// The only question that matters is whether `fitted` beats `shrunk` out of
// sample. Beating `null` or `raw` proves nothing about edge.

import { fitOLS, probOver } from './stats.js';

const shrinkRow = r => [1, r.baseline];

const fullRow = r => {
  const mismatch = r.mismatch ?? 0;
  return [1, r.baseline, mismatch, r.baseline * mismatch, r.blockiness];
};

const fitOn = (rows, design) =>
  fitOLS(rows.map(design), rows.map(r => r.actual), 1e-4);

export const fitShrink = rows => fitOn(rows, shrinkRow);
export const fit = rows => fitOn(rows, fullRow);

function apply(row, coef, design, fallback) {
  if (!coef) return fallback;
  const x = design(row);
  let mu = 0;
  for (let i = 0; i < coef.length; i++) mu += coef[i] * x[i];
  // Guard against a degenerate fit producing nonsense on an outlier row.
  if (!isFinite(mu) || mu < 2 || mu > 25) return fallback;
  return mu;
}

export const predictNull = row => row.lgMean;
export const predictRaw = row => row.baseline;
export const predictShrunk = (row, coef) => apply(row, coef, shrinkRow, row.lgMean);
export const predictFitted = (row, coef) => apply(row, coef, fullRow, row.lgMean);

/** Projected mean -> market-facing probability, using NB dispersion `r`. */
export function overProbability(mu, line, r) {
  return probOver(line, mu, r);
}

/** Edge in percentage points against a vig-adjusted market probability. */
export function edgeVsMarket(modelProbOver, overOdds, underOdds) {
  if (!(overOdds > 1 && underOdds > 1)) return null;
  const ro = 1 / overOdds, ru = 1 / underOdds;
  const s = ro + ru;
  const fairOver = ro / s;
  return {
    fairOver,
    overround: s - 1,
    edgeOver: (modelProbOver - fairOver) * 100,
    edgeUnder: ((1 - modelProbOver) - (1 - fairOver)) * 100,
  };
}
