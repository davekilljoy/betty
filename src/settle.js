// Settlement: pull Sleeper actuals for a week, grade every open leg, then settle any bet
// whose legs are all resolved. Pays out via the ledger. Idempotent — safe to re-run.
const { db, now } = require('./db');
const { fetchActuals } = require('./sleeper');

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

// Freeze trading on any market whose kickoff has passed.
const freezeKickoffs = db.prepare(
  "UPDATE markets SET status='FROZEN' WHERE status='OPEN' AND kickoff_ts <= ?"
);
function freezeDue() {
  const r = freezeKickoffs.run(now());
  if (r.changes) console.log(`[settle] froze ${r.changes} markets at kickoff`);
  return r.changes;
}

function round2(x) { return Math.round(x * 100) / 100; }

module.exports = { settleWeek, finalizeBet, gradeLeg, freezeDue };
