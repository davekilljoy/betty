// Settlement: pull Sleeper actuals for a week, grade every open leg, then settle any bet
// whose legs are all resolved. Pays out via the ledger. Idempotent — safe to re-run.
const { db, now } = require('./db');
const { fetchActuals } = require('./sleeper');
const { fetchMatchups } = require('./league');

const openMarketsForWeek = db.prepare(
  "SELECT * FROM markets WHERE week=? AND status IN ('OPEN','FROZEN','SETTLING')"
);
const setMarketSettled = db.prepare('UPDATE markets SET status=?, actual_value=? WHERE id=?');
const openLegsForMarket = db.prepare("SELECT * FROM bet_legs WHERE market_id=? AND status='OPEN'");
const setLeg = db.prepare('UPDATE bet_legs SET status=?, actual_value=? WHERE id=?');
const getBet = db.prepare('SELECT * FROM bets WHERE id=?');
const legsForBet = db.prepare('SELECT * FROM bet_legs WHERE bet_id=?');
const setBet = db.prepare('UPDATE bets SET status=?, payout=?, combined_odds=?, potential=?, settled_ts=? WHERE id=?');
const addLedger = db.prepare(
  'INSERT INTO ledger (username, week, delta, reason, bet_id, ts) VALUES (?,?,?,?,?,?)'
);

function gradeLeg(side, threshold, actual) {
  if (actual === null || actual === undefined) return 'VOID'; // DNP / inactive
  if (side === 'OVER') return actual > threshold ? 'WON' : 'LOST';
  return actual < threshold ? 'WON' : 'LOST';
}

// Try to finalize a bet if all its legs are resolved. VOID legs drop out; combined odds
// recompute over surviving (WON/LOST) legs. Bet wins iff every surviving leg WON.
const finalizeBet = db.transaction((betId) => {
  const bet = getBet.get(betId);
  if (!bet || bet.status !== 'OPEN') return;
  const legs = legsForBet.all(betId);
  if (legs.some((l) => l.status === 'OPEN')) return; // not all graded yet

  const live = legs.filter((l) => l.status !== 'VOID');
  if (live.length === 0) {
    // every leg voided -> refund stake, bet VOID
    setBet.run('VOID', 0, 1, bet.stake, now(), betId);
    addLedger.run(bet.username, bet.week, bet.stake, 'refund', betId, now());
    return;
  }
  const combined = live.reduce((acc, l) => acc * l.odds, 1);
  const potential = Math.floor(bet.stake * combined);
  const won = live.every((l) => l.status === 'WON');
  const payout = won ? potential : 0;
  setBet.run(won ? 'WON' : 'LOST', payout, round2(combined), potential, now(), betId);
  if (payout > 0) addLedger.run(bet.username, bet.week, payout, 'payout', betId, now());
});

async function settleWeek(week) {
  const markets = openMarketsForWeek.all(week);
  if (markets.length === 0) return { graded: 0, bets: 0 };

  let actuals;
  try {
    actuals = await fetchActuals(week);
  } catch (e) {
    console.warn(`[settle] actuals fetch failed for week ${week}: ${e.message}`);
    return { graded: 0, bets: 0, error: e.message };
  }

  const touchedBets = new Set();
  let graded = 0;

  const gradeMarket = db.transaction((m) => {
    if (!actuals.has(m.player_id)) return; // no data yet — leave open, retry next run
    const actual = actuals.get(m.player_id);
    setMarketSettled.run(actual === null ? 'VOID' : 'SETTLED', actual, m.id);
    for (const leg of openLegsForMarket.all(m.id)) {
      const result = gradeLeg(leg.side, leg.threshold, actual);
      setLeg.run(result, actual, leg.id);
      touchedBets.add(leg.bet_id);
      graded++;
    }
  });

  for (const m of markets) gradeMarket(m);
  for (const betId of touchedBets) finalizeBet(betId);

  console.log(`[settle] week ${week}: graded ${graded} legs across ${touchedBets.size} bets`);
  return { graded, bets: touchedBets.size };
}

// --- H2H matchup settlement --------------------------------------------------
const openMatchupsForWeek = db.prepare(
  "SELECT * FROM matchups WHERE week=? AND status IN ('OPEN','FROZEN','SETTLING')"
);
const setMatchupSettled = db.prepare('UPDATE matchups SET status=?, actual_a=?, actual_b=?, winner=? WHERE id=?');
const openMatchupLegs = db.prepare("SELECT * FROM bet_legs WHERE matchup_id=? AND leg_kind='matchup' AND status='OPEN'");

async function settleMatchups(week, pointsOverride) {
  const matchups = openMatchupsForWeek.all(week);
  if (matchups.length === 0) return { graded: 0, bets: 0 };

  let points = pointsOverride; // test hook: inject final scores (roster_id -> points)
  if (!points) {
    try {
      const rows = await fetchMatchups(week);
      points = new Map((rows || []).map((r) => [r.roster_id, r.points]));
    } catch (e) {
      console.warn(`[settle] matchup points fetch failed for week ${week}: ${e.message}`);
      return { graded: 0, bets: 0, error: e.message };
    }
  }

  const touched = new Set();
  let graded = 0;

  const gradeMatchup = db.transaction((m) => {
    if (now() < m.settle_after) return;                 // games not final yet
    const pa = points.get(m.roster_a), pb = points.get(m.roster_b);
    if (!(pa > 0) && !(pb > 0)) return;                 // not played
    const winner = pa === pb ? 0 : pa > pb ? m.roster_a : m.roster_b;
    setMatchupSettled.run('SETTLED', pa, pb, winner, m.id);
    for (const leg of openMatchupLegs.all(m.id)) {
      const pick = leg.pick_roster === m.roster_a ? pa : pb;
      const opp = leg.pick_roster === m.roster_a ? pb : pa;
      const margin = Math.round((pick - opp) * 10) / 10;
      setLeg.run(margin > leg.threshold ? 'WON' : 'LOST', margin, leg.id);
      touched.add(leg.bet_id);
      graded++;
    }
  });

  for (const m of matchups) gradeMatchup(m);
  for (const betId of touched) finalizeBet(betId);

  console.log(`[settle] week ${week} matchups: graded ${graded} legs across ${touched.size} bets`);
  return { graded, bets: touched.size };
}

// Freeze trading on any market/matchup whose kickoff has passed.
const freezeKickoffs = db.prepare(
  "UPDATE markets SET status='FROZEN' WHERE status='OPEN' AND kickoff_ts <= ?"
);
const freezeMatchups = db.prepare(
  "UPDATE matchups SET status='FROZEN' WHERE status='OPEN' AND kickoff_ts <= ?"
);
function freezeDue() {
  const r = freezeKickoffs.run(now());
  const rm = freezeMatchups.run(now());
  if (r.changes || rm.changes) console.log(`[settle] froze ${r.changes} markets, ${rm.changes} matchups`);
  return r.changes + rm.changes;
}

function round2(x) { return Math.round(x * 100) / 100; }

module.exports = { settleWeek, settleMatchups, finalizeBet, gradeLeg, freezeDue };
