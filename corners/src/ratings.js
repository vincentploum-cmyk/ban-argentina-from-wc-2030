// Team attack/defence ratings, fitted by iterative proportional fitting.
//
// Why this exists: a 12-match rolling average is a badly noisy estimate of a
// team's rate — we measured ~65% of its spread as sampling error. A ratings
// model uses EVERY prior match (time-decayed) and, crucially, adjusts for who
// the opponents were. A team that faced the six best defences looks weak on a
// rolling average; ratings correct for that.
//
// Model, per league and per metric (corners, dangerous attacks, ...):
//     E[home value] = lgHome * atk[home] * def[away]
//     E[away value] = lgAway * atk[away] * def[home]
// Fitted by alternating closed-form updates until stable, then atk normalised
// to mean 1 so ratings are league-relative and comparable.

const HALFLIFE_DAYS = 180;
const DAY = 86400;

/**
 * @param {Array} prior completed matches in ONE league, each
 *   { date, home, away, hv, av }  (hv/av = the metric's home/away value)
 * @param {number} asOf unix seconds — decay is measured back from here
 * @returns {{atk:Map, def:Map, lgHome:number, lgAway:number, n:number}|null}
 */
export function fitRatings(prior, asOf, { halflifeDays = HALFLIFE_DAYS, iters = 15, minMatches = 40 } = {}) {
  const games = prior.filter(g => Number.isFinite(g.hv) && Number.isFinite(g.av));
  if (games.length < minMatches) return null;

  const lambda = Math.LN2 / (halflifeDays * DAY);
  const w = games.map(g => Math.exp(-lambda * Math.max(0, asOf - g.date)));

  let sw = 0, shv = 0, sav = 0;
  for (let i = 0; i < games.length; i++) { sw += w[i]; shv += w[i] * games[i].hv; sav += w[i] * games[i].av; }
  if (!(sw > 0)) return null;
  const lgHome = shv / sw, lgAway = sav / sw;
  if (!(lgHome > 0) || !(lgAway > 0)) return null;

  const atk = new Map(), def = new Map();
  for (const g of games) {
    if (!atk.has(g.home)) { atk.set(g.home, 1); def.set(g.home, 1); }
    if (!atk.has(g.away)) { atk.set(g.away, 1); def.set(g.away, 1); }
  }

  const clamp = x => (!isFinite(x) || x <= 0 ? 1 : Math.min(4, Math.max(0.25, x)));

  for (let it = 0; it < iters; it++) {
    // attack: observed scored / expected-scored given current opponent defences
    const aNum = new Map(), aDen = new Map();
    for (let i = 0; i < games.length; i++) {
      const g = games[i], wi = w[i];
      aNum.set(g.home, (aNum.get(g.home) || 0) + wi * g.hv);
      aDen.set(g.home, (aDen.get(g.home) || 0) + wi * lgHome * def.get(g.away));
      aNum.set(g.away, (aNum.get(g.away) || 0) + wi * g.av);
      aDen.set(g.away, (aDen.get(g.away) || 0) + wi * lgAway * def.get(g.home));
    }
    for (const t of atk.keys()) atk.set(t, clamp((aNum.get(t) || 0) / (aDen.get(t) || 1e-9)));

    // defence: observed conceded / expected-conceded given current opponent attacks
    const dNum = new Map(), dDen = new Map();
    for (let i = 0; i < games.length; i++) {
      const g = games[i], wi = w[i];
      dNum.set(g.away, (dNum.get(g.away) || 0) + wi * g.hv);
      dDen.set(g.away, (dDen.get(g.away) || 0) + wi * lgHome * atk.get(g.home));
      dNum.set(g.home, (dNum.get(g.home) || 0) + wi * g.av);
      dDen.set(g.home, (dDen.get(g.home) || 0) + wi * lgAway * atk.get(g.away));
    }
    for (const t of def.keys()) def.set(t, clamp((dNum.get(t) || 0) / (dDen.get(t) || 1e-9)));
  }

  // normalise attack to mean 1 (ratings are league-relative)
  let m = 0; for (const v of atk.values()) m += v; m /= atk.size || 1;
  if (m > 0) for (const [t, v] of atk) atk.set(t, v / m);

  return { atk, def, lgHome, lgAway, n: games.length };
}

/** Expected value for one side of a fixture. Null if either team is unrated. */
export function ratingProjection(R, attacker, defender, isHome) {
  if (!R) return null;
  const a = R.atk.get(attacker), d = R.def.get(defender);
  if (a == null || d == null) return null;
  return (isHome ? R.lgHome : R.lgAway) * a * d;
}
