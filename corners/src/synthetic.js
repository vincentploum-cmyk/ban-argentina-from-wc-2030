// Synthetic match generator with a KNOWN corner-generating process.
//
// Used to validate the harness itself: if the backtest cannot recover a signal
// we deliberately planted, its "no signal" verdict on real data is worthless.
// Equally, if it reports a signal in data generated without one, it is lying.

const mulberry32 = seed => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function gammaSample(rand, shape) {
  if (shape < 1) return gammaSample(rand, shape + 1) * Math.pow(rand(), 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(rand); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normal(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function poissonSample(rand, mu) {
  if (mu > 30) return Math.max(0, Math.round(mu + Math.sqrt(mu) * normal(rand)));
  const L = Math.exp(-mu);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

// Negative binomial as a gamma-Poisson mixture.
const nbSample = (rand, mu, r) =>
  poissonSample(rand, gammaSample(rand, r) * (mu / r));

/**
 * @param {object} o
 *  - teams        teams per league
 *  - leagues      number of leagues
 *  - rounds       double round-robins to play
 *  - mismatchBeta strength of the planted "favourite vs low block" effect.
 *                 0 = no effect beyond team rates. 0.35 = strong.
 *  - noise        if true, corners ignore team identity entirely.
 */
export function generate({
  teams = 20, leagues = 2, rounds = 2, mismatchBeta = 0, noise = false, seed = 42,
} = {}) {
  const rand = mulberry32(seed);
  const matches = [];
  const DAY = 86400;
  let clock = 1600000000;

  for (let lg = 0; lg < leagues; lg++) {
    // Latent per-team traits.
    const roster = Array.from({ length: teams }, (_, i) => ({
      name: `L${lg}T${i}`,
      attack: 4.2 + normal(rand) * 0.9,   // corners won per match
      defence: 4.2 + normal(rand) * 0.9,  // corners conceded per match
      strength: normal(rand),             // drives the odds
    }));

    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < teams; i++) {
        for (let j = 0; j < teams; j++) {
          if (i === j) continue;
          const h = roster[i], a = roster[j];
          clock += Math.floor(DAY / 4);

          // Match odds from strength difference (home advantage baked in).
          const diff = h.strength - a.strength + 0.35;
          const pH = 1 / (1 + Math.exp(-1.1 * diff));
          const pD = 0.26 * (1 - Math.abs(pH - 0.5) * 1.2);
          const pA = Math.max(0.02, 1 - pH - pD);
          const nH = pH / (pH + pD + pA), nD = pD / (pH + pD + pA), nA = pA / (pH + pD + pA);
          const vig = 1.06;

          const mismatch = Math.abs(nH - nA);
          const boost = 1 + mismatchBeta * mismatch;

          let muH, muA;
          if (noise) {
            muH = 5.2; muA = 4.8;
          } else {
            muH = ((h.attack + a.defence) / 2) * 1.10 * boost; // home tilt
            muA = ((a.attack + h.defence) / 2) * 0.92 * boost;
          }

          matches.push({
            date: clock,
            league: `LG${lg}`,
            home: h.name,
            away: a.name,
            hc: nbSample(rand, Math.max(0.5, muH), 12),
            ac: nbSample(rand, Math.max(0.5, muA), 12),
            odds: { h: vig / nH, d: vig / nD, a: vig / nA },
          });
        }
      }
    }
  }
  return matches.sort((x, y) => x.date - y.date);
}
