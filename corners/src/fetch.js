// Pull completed matches with corner counts from FootyStats into data/matches.json.
//
//   FOOTYSTATS_KEY=xxx node src/fetch.js --seasons 15050,14956,15068 [--out data/matches.json]
//
// Season IDs are the same `season_id` values the live site already uses in its
// LEAGUE_NAMES map. Corner counts come back as -1 when FootyStats has no data
// for that fixture; those rows are dropped rather than zero-filled — a zero
// would poison every rolling rate that touches the team.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const KEY = process.env.FOOTYSTATS_KEY;
const BASE = 'https://api.football-data-api.com';
const OUT = arg('out', 'data/matches.json');
const SEASONS = arg('seasons', '').split(',').map(s => s.trim()).filter(Boolean);

if (!KEY) {
  console.error('Set FOOTYSTATS_KEY in the environment. Do not hardcode it —');
  console.error('the key currently committed inside `golden server.js` is exposed and should be rotated.');
  process.exit(1);
}
if (!SEASONS.length) {
  console.error('Pass --seasons <comma-separated season_id list>.');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, attempt = 0) {
  try {
    const res = await fetch(url);
    if (res.status === 429 && attempt < 5) {
      await sleep(2000 * 2 ** attempt);
      return getJSON(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt < 4) {
      await sleep(2000 * 2 ** attempt);
      return getJSON(url, attempt + 1);
    }
    throw e;
  }
}

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchSeason(sid) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const url = `${BASE}/league-matches?season_id=${sid}&max_per_page=500&page=${page}&key=${KEY}`;
    const json = await getJSON(url);
    const data = json?.data ?? [];
    if (!data.length) break;

    for (const m of data) {
      if (m.status !== 'complete') continue;
      const hc = num(m.team_a_corners);
      const ac = num(m.team_b_corners);
      // FootyStats uses -1 for "not recorded".
      if (hc === null || ac === null || hc < 0 || ac < 0) continue;
      if (!m.home_name || !m.away_name || !m.date_unix) continue;

      const o1 = num(m.odds_ft_1), ox = num(m.odds_ft_x), o2 = num(m.odds_ft_2);
      out.push({
        date: m.date_unix,
        league: `S${sid}`,
        home: m.home_name,
        away: m.away_name,
        hc, ac,
        ...(o1 > 1 && ox > 1 && o2 > 1 ? { odds: { h: o1, d: ox, a: o2 } } : {}),
      });
    }

    const totalPages = json?.pager?.max_page ?? 1;
    if (page >= totalPages) break;
    await sleep(300);
  }
  return out;
}

const all = [];
for (const sid of SEASONS) {
  process.stdout.write(`season ${sid} ... `);
  try {
    const rows = await fetchSeason(sid);
    all.push(...rows);
    const withOdds = rows.filter(r => r.odds).length;
    console.log(`${rows.length} matches with corners (${withOdds} with 1X2 odds)`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  }
}

all.sort((a, b) => a.date - b.date);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(all));

const span = all.length
  ? `${new Date(all[0].date * 1000).toISOString().slice(0, 10)} to ${new Date(all[all.length - 1].date * 1000).toISOString().slice(0, 10)}`
  : 'n/a';
console.log(`\nwrote ${all.length} matches to ${OUT}  (${span})`);
if (all.length < 1500) {
  console.log('Fewer than ~1500 matches: expect the backtest to be underpowered.');
}
