// Sleeper ingest: pull projections -> create markets + odds ladders. Pull actuals ->
// feed settlement. Sleeper is the only data source.
//
// NOTE: it's the offseason (no live week data), so ingest falls back to a built-in seed
// of realistic players/projections when Sleeper returns nothing. Set BETTY_SEED=0 to
// disable the fallback once the season is live.
const { db, now, currentPeriod } = require('./db');
const { buildLadder } = require('./odds');

const SEASON = Number(process.env.BETTY_SEASON || 2025);
const PPR = { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, pass_yd: 0.04, pass_td: 4, pass_int: -2, fum_lost: -2 };

// --- Sleeper HTTP ------------------------------------------------------------
async function sleeperJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'betty/0.1' } });
  if (!res.ok) throw new Error(`Sleeper ${res.status} for ${url}`);
  return res.json();
}

// Projections for a week, keyed by player_id -> {name, team, position, ppr_pts}.
async function fetchProjections(week) {
  const url = `https://api.sleeper.com/projections/nfl/${SEASON}/${week}?season_type=regular&order_by=ppr`;
  const rows = await sleeperJson(url);
  const out = [];
  for (const r of rows || []) {
    const p = r.player || {};
    const pos = (p.position || (p.fantasy_positions || [])[0] || '').toUpperCase();
    if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;
    const ppr = pprFromStats(r.stats || {});
    if (ppr < 4) continue; // skip deep bench noise
    out.push({
      player_id: String(r.player_id),
      player_name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || String(r.player_id),
      team: p.team || null,
      position: pos,
      ppr_pts: ppr,
    });
  }
  return out;
}

// Weekly NFL schedule -> map team -> { opp, home, date }. Used to show who each player
// is up against (critical betting context) and to set a real kickoff/freeze time.
async function fetchSchedule(week) {
  const games = await sleeperJson(`https://api.sleeper.com/schedule/nfl/regular/${SEASON}`);
  const map = new Map();
  for (const g of games || []) {
    if (g.week !== week || !g.home || !g.away) continue;
    const kickoff = Date.parse(`${g.date}T17:00:00Z`) || null; // ~1pm ET game day
    map.set(g.home, { opp: g.away, home: 1, date: kickoff });
    map.set(g.away, { opp: g.home, home: 0, date: kickoff });
  }
  return map;
}

// Actual scored stats for a week, keyed by player_id -> ppr points (or null if DNP).
async function fetchActuals(week) {
  const url = `https://api.sleeper.com/stats/nfl/${SEASON}/${week}?season_type=regular`;
  const rows = await sleeperJson(url);
  const map = new Map();
  for (const r of rows || []) {
    const s = r.stats || {};
    // gp (games played) absent/0 => did not play this week.
    const played = (s.gp ?? 0) > 0 || s.off_snp > 0 || s.tm_off_snp > 0;
    map.set(String(r.player_id), played ? pprFromStats(s) : null);
  }
  return map;
}

function pprFromStats(s) {
  let pts = 0;
  for (const [k, mult] of Object.entries(PPR)) pts += (s[k] || 0) * mult;
  // If Sleeper already gives a pts_ppr, trust it.
  if (typeof s.pts_ppr === 'number') return round1(s.pts_ppr);
  return round1(pts);
}
function round1(x) { return Math.round(x * 10) / 10; }

// --- Market creation ---------------------------------------------------------
const upsertMarket = db.prepare(`
  INSERT INTO markets (week, player_id, player_name, team, position, opponent, is_home, stat,
                       projection, kickoff_ts, settle_after, status, created_ts)
  VALUES (@week,@player_id,@player_name,@team,@position,@opponent,@is_home,'ppr_pts',
          @projection,@kickoff_ts,@settle_after,'OPEN',@created_ts)
  ON CONFLICT(week, player_id, stat) DO UPDATE SET
    projection=excluded.projection, opponent=excluded.opponent, is_home=excluded.is_home
  RETURNING id`);
const clearRungs = db.prepare('DELETE FROM rungs WHERE market_id=?');
const insRung = db.prepare(`INSERT OR IGNORE INTO rungs (market_id, side, threshold, odds, implied_prob)
  VALUES (?,?,?,?,?)`);

const ingestWeek = db.transaction((week, players, schedule, fallbackKickoff) => {
  let created = 0;
  for (const pl of players) {
    const g = schedule.get(pl.team);
    const kickoff = (g && g.date) || fallbackKickoff;
    const mid = upsertMarket.get({
      week,
      player_id: pl.player_id,
      player_name: pl.player_name,
      team: pl.team,
      position: pl.position,
      opponent: g ? g.opp : null,
      is_home: g ? g.home : 1,
      projection: pl.ppr_pts,
      kickoff_ts: kickoff,
      settle_after: kickoff + 4 * 3600 * 1000, // ~4h after kickoff
      created_ts: now(),
    }).id;
    clearRungs.run(mid); // markets that are still OPEN get a refreshed ladder
    for (const r of buildLadder(pl.ppr_pts, pl.position)) {
      insRung.run(mid, r.side, r.threshold, r.odds, r.implied_prob);
    }
    created++;
  }
  return created;
});

// Top-level ingest for the active period. Falls back to seed in the offseason.
async function ingest({ week = currentPeriod(), kickoff_ts } = {}) {
  const k = kickoff_ts || now() + 24 * 3600 * 1000; // default: freezes in 24h
  let players = [];
  try {
    players = await fetchProjections(week);
  } catch (e) {
    console.warn(`[sleeper] projections fetch failed (${e.message}) — using seed`);
  }
  if (players.length === 0 && process.env.BETTY_SEED !== '0') {
    players = require('./seed').seedPlayers();
    console.log(`[sleeper] offseason: seeded ${players.length} players for week ${week}`);
  }
  let schedule = new Map();
  try {
    schedule = await fetchSchedule(week);
  } catch (e) {
    console.warn(`[sleeper] schedule fetch failed (${e.message}) — no opponents this run`);
  }
  const n = ingestWeek(week, players, schedule, k);
  console.log(`[sleeper] ingested ${n} markets for week ${week} (${schedule.size / 2 | 0} games)`);
  return n;
}

module.exports = { ingest, fetchProjections, fetchActuals, pprFromStats, SEASON };
