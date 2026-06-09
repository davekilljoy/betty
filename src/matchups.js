// H2H matchup ingest: pair league rosters by matchup_id, sum each roster's starter
// projections into a team total, and price a moneyline + alternate spreads per side.
const { db, now } = require('./db');
const { buildMatchupRungs, marginWinProb } = require('./odds');
const { fetchMembers, fetchRosters, fetchMatchups } = require('./league');
const { fetchProjectionMap, fetchSchedule } = require('./sleeper');

const upsertMatchup = db.prepare(`
  INSERT INTO matchups (week, matchup_id, roster_a, roster_b, manager_a, manager_b,
                        avatar_a, avatar_b, proj_a, proj_b, win_prob_a,
                        kickoff_ts, settle_after, status, created_ts)
  VALUES (@week,@matchup_id,@roster_a,@roster_b,@manager_a,@manager_b,@avatar_a,@avatar_b,
          @proj_a,@proj_b,@win_prob_a,@kickoff_ts,@settle_after,'OPEN',@created_ts)
  ON CONFLICT(week, matchup_id) DO UPDATE SET
    proj_a=excluded.proj_a, proj_b=excluded.proj_b, win_prob_a=excluded.win_prob_a,
    manager_a=excluded.manager_a, manager_b=excluded.manager_b
  RETURNING id`);
const clearMRungs = db.prepare('DELETE FROM matchup_rungs WHERE matchup_id=?');
const insMRung = db.prepare(`INSERT OR IGNORE INTO matchup_rungs
  (matchup_id, pick_roster, kind, spread, odds, implied_prob) VALUES (?,?,?,?,?,?)`);

async function ingestMatchups({ week } = {}) {
  const [members, rosters, schedule] = await Promise.all([
    fetchMembers(), fetchRosters(), fetchMatchups(week),
  ]);
  const proj = await fetchProjectionMap(week);
  let kickoff;
  try {
    const dates = [...(await fetchSchedule(week)).values()].map((g) => g.date).filter(Boolean);
    kickoff = dates.length ? Math.min(...dates) : now() + 24 * 3600 * 1000;
  } catch { kickoff = now() + 24 * 3600 * 1000; }

  const byOwner = new Map(members.map((m) => [m.user_id, m]));
  const rosterById = new Map(rosters.map((r) => [r.roster_id, r]));
  const teamProj = (rid) => {
    const r = rosterById.get(rid);
    if (!r) return 0;
    return Math.round((r.starters || []).reduce((s, pid) => s + (proj.get(String(pid)) || 0), 0) * 10) / 10;
  };
  const mgr = (rid) => {
    const r = rosterById.get(rid);
    const m = r && byOwner.get(r.owner_id);
    return m || { display_name: `Roster ${rid}`, avatar: null };
  };

  // group rosters by matchup_id
  const groups = new Map();
  for (const s of schedule || []) {
    if (s.matchup_id == null) continue;
    if (!groups.has(s.matchup_id)) groups.set(s.matchup_id, []);
    groups.get(s.matchup_id).push(s.roster_id);
  }

  const existingMatchup = db.prepare('SELECT id, status, proj_a, proj_b FROM matchups WHERE week=? AND matchup_id=?');
  const run = db.transaction(() => {
    let n = 0;
    for (const [mid, rids] of groups) {
      if (rids.length !== 2) continue;
      const ex = existingMatchup.get(week, mid);
      if (ex && ex.status !== 'OPEN') continue;              // don't re-price frozen/settled
      const [a, b] = rids;
      const projA = teamProj(a), projB = teamProj(b);
      if (ex && ex.proj_a === projA && ex.proj_b === projB) continue; // unchanged, no churn
      const ma = mgr(a), mb = mgr(b);
      const row = upsertMatchup.get({
        week, matchup_id: mid, roster_a: a, roster_b: b,
        manager_a: ma.display_name, manager_b: mb.display_name,
        avatar_a: ma.avatar, avatar_b: mb.avatar,
        proj_a: projA, proj_b: projB, win_prob_a: marginWinProb(projA, projB),
        kickoff_ts: kickoff, settle_after: kickoff + 4 * 3600 * 1000, created_ts: now(),
      });
      clearMRungs.run(row.id);
      for (const r of buildMatchupRungs(projA, projB)) {
        const pick = r.side === 'A' ? a : b;
        insMRung.run(row.id, pick, r.kind, r.spread, r.odds, r.prob);
      }
      n++;
    }
    return n;
  });
  const n = run();
  console.log(`[matchups] ingested ${n} matchups for week ${week}`);
  return n;
}

module.exports = { ingestMatchups };
