// End-to-end proof of settlement + cash-out, against REAL completed 2025 data.
//
// Player props settle against real 2025 week-1 stats (deterministic truth). Matchups
// settle against injected final scores (the league's own games haven't been played), so
// we can exercise every grading branch: favorite/dog moneyline, spread cover, and a push.
//
//   node src/sim.js     (or: npm run sim)
//
// It places a battery of bets through the real HTTP endpoints, cashes some out, advances
// the clock, settles, then independently recomputes every outcome and checks the books.

process.env.BETTY_DB = process.env.BETTY_DB || 'data/sim.db';
process.env.BETTY_SEASON = '2025';
process.env.BETTY_MARKET_WEEK = '1';
process.env.BETTY_AUTOPOLL = '0';
process.env.BETTY_AUTOSETTLE = '0';
process.env.PORT = process.env.PORT || '3099';

const PLACE_T = Date.parse('2025-09-02T12:00:00Z');   // before week-1 kickoffs: markets OPEN
const SETTLE_T = Date.parse('2025-12-01T12:00:00Z');  // well after: settlement allowed
process.env.BETTY_NOW = String(PLACE_T);

const fs = require('fs');
for (const f of ['sim.db', 'sim.db-wal', 'sim.db-shm']) { try { fs.unlinkSync('data/' + f); } catch {} }

const { start } = require('./server');
const { db, spendableBalance } = require('./db');
const { fetchActuals } = require('./sleeper');
const { settleWeek, settleMatchups, freezeDue, gradeLeg } = require('./settle');
const { legWinProb } = require('./odds');

const PEN = Number(process.env.BETTY_CASHOUT_PENALTY || 0.10);
const BASE = `http://localhost:${process.env.PORT}`;
const api = async (p, o) => (await fetch(BASE + p, o)).json();
const post = (p, b) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
const section = (s) => console.log(`\n== ${s} ==`);

async function placeBet(username, body) {
  const r = await post('/api/bets', { username, stake: body.stake, rungIds: body.rungIds || [], mRungIds: body.mRungIds || [] });
  if (r.error) throw new Error(`place failed for ${username}: ${r.error}`);
  return r.bet;
}

(async () => {
  await start();

  const markets = (await api('/api/markets')).markets;
  const matchups = (await api('/api/matchups')).matchups;
  const mById = new Map(markets.map((m) => [m.id, m]));
  const pick = (m, side, idx = 0) => m.rungs.filter((r) => r.side === side).sort((a, b) => a.threshold - b.threshold)[idx];

  // ---------------- gradeLeg unit checks (incl. the VOID branch) ----------------
  section('gradeLeg branches');
  check('OVER hit', gradeLeg('OVER', 12.5, 20) === 'WON');
  check('OVER miss', gradeLeg('OVER', 12.5, 8) === 'LOST');
  check('UNDER hit', gradeLeg('UNDER', 12.5, 8) === 'WON');
  check('UNDER miss', gradeLeg('UNDER', 12.5, 20) === 'LOST');
  check('DNP voids', gradeLeg('OVER', 12.5, null) === 'VOID');

  // ---------------- place + cash out (penalty proof) ----------------
  section('cash-out penalty');
  const aOver = pick(markets[0], 'OVER', 0);
  const aBet = await placeBet('alice', { stake: 100, rungIds: [aOver.id] });
  // independent re-price: same projection (no line move in the sim)
  const am = mById.get(markets[0].id);
  const aProb = legWinProb(am.projection, am.position, 'OVER', aOver.threshold);
  const aFair = Math.floor(aBet.potential * aProb);
  const aExpected = Math.floor(aBet.potential * aProb * (1 - PEN));
  const aQuote = (await api(`/api/mybets?username=alice`)).bets.find((b) => b.id === aBet.id).cashout;
  check('quoted == formula', aQuote === aExpected, `quote ${aQuote} expected ${aExpected}`);
  check('penalty makes it < fair value', aExpected < aFair, `cashout ${aExpected} < fair ${aFair}`);
  const aCash = await post(`/api/bets/${aBet.id}/cashout`, { username: 'alice' });
  check('cash-out paid the quote', aCash.value === aExpected, `paid ${aCash.value}`);
  check('alice balance reconciles', spendableBalance('alice') === 1000 - 100 + aExpected,
    `bal ${spendableBalance('alice')}`);

  // parlay cash-out
  const pl1 = pick(markets[5], 'OVER', 1), pl2 = pick(markets[6], 'OVER', 1);
  const pBet = await placeBet('paul', { stake: 50, rungIds: [pl1.id, pl2.id] });
  const pProb = legWinProb(mById.get(markets[5].id).projection, mById.get(markets[5].id).position, 'OVER', pl1.threshold)
    * legWinProb(mById.get(markets[6].id).projection, mById.get(markets[6].id).position, 'OVER', pl2.threshold);
  const pExpected = Math.floor(pBet.potential * pProb * (1 - PEN));
  const pCash = await post(`/api/bets/${pBet.id}/cashout`, { username: 'paul' });
  check('parlay cash-out == formula', pCash.value === pExpected, `paid ${pCash.value} expected ${pExpected}`);

  // ---------------- bets that will settle ----------------
  const bOver = pick(markets[1], 'OVER', 0);   // bob: safe over
  const cUnder = pick(markets[2], 'UNDER', 0); // carol: under
  const f1 = pick(markets[3], 'OVER', 0), f2 = pick(markets[4], 'OVER', 0); // frank: parlay
  const bBet = await placeBet('bob', { stake: 100, rungIds: [bOver.id] });
  const cBet = await placeBet('carol', { stake: 100, rungIds: [cUnder.id] });
  const fBet = await placeBet('frank', { stake: 40, rungIds: [f1.id, f2.id] });

  // matchup bets + synthetic finals
  const m0 = matchups[0], m1 = matchups[1], m2 = matchups[2];
  const favRoster = m0.win_prob_a >= 0.5 ? m0.roster_a : m0.roster_b;
  const dogRoster = favRoster === m0.roster_a ? m0.roster_b : m0.roster_a;
  const favML = m0.rungs.find((r) => r.kind === 'ml' && r.pick_roster === favRoster);
  const dogML = m0.rungs.find((r) => r.kind === 'ml' && r.pick_roster === dogRoster);
  const dBet = await placeBet('dave2', { stake: 100, mRungIds: [favML.id] });
  const eBet = await placeBet('erin', { stake: 100, mRungIds: [dogML.id] });
  const gSpread = m1.rungs.find((r) => r.kind === 'spread' && r.pick_roster === m1.roster_a);
  const hSpread = m2.rungs.find((r) => r.kind === 'spread' && r.pick_roster === m2.roster_a);
  const gBet = await placeBet('grace', { stake: 100, mRungIds: [gSpread.id] });
  const hBet = await placeBet('hank', { stake: 100, mRungIds: [hSpread.id] });

  // synthetic final scores: m0 dog wins by 5; m1 exact push; m2 roster_a covers by +10
  const synthetic = new Map();
  synthetic.set(favRoster, 100); synthetic.set(dogRoster, 105);              // dog +5
  synthetic.set(m1.roster_a, 100 + gSpread.spread); synthetic.set(m1.roster_b, 100); // margin == spread
  synthetic.set(m2.roster_a, 100 + hSpread.spread + 10); synthetic.set(m2.roster_b, 100); // covers

  // ---------------- advance clock + settle ----------------
  section('settlement');
  process.env.BETTY_NOW = String(SETTLE_T);
  freezeDue();
  const ps = await settleWeek(1);                 // real 2025 actuals
  const ms = await settleMatchups(1, synthetic);  // injected finals
  console.log(`  settled players: ${ps.graded} legs / ${ps.bets} bets; matchups: ${ms.graded} legs / ${ms.bets} bets`);

  // independent verification of player legs against real actuals
  const actuals = await fetchActuals(1);
  const betRow = db.prepare('SELECT * FROM bets WHERE id=?');
  function verifyPlayerBet(bet, label) {
    const legs = db.prepare('SELECT * FROM bet_legs WHERE bet_id=?').all(bet.id);
    let expectAllWon = true, anyLive = false;
    for (const l of legs) {
      const m = db.prepare('SELECT player_id FROM markets WHERE id=?').get(l.market_id);
      const actual = actuals.has(m.player_id) ? actuals.get(m.player_id) : undefined;
      if (actual === undefined) continue; // not in feed; settle would have left open (shouldn't happen for studs)
      const exp = gradeLeg(l.side, l.threshold, actual);
      check(`${label}: leg ${l.player_name} graded ${exp}`, l.status === exp, `actual ${actual} thr ${l.threshold}`);
      if (exp === 'VOID') continue;
      anyLive = true;
      if (exp !== 'WON') expectAllWon = false;
    }
    const b = betRow.get(bet.id);
    const expStatus = !anyLive ? 'VOID' : expectAllWon ? 'WON' : 'LOST';
    check(`${label}: bet status ${expStatus}`, b.status === expStatus, `got ${b.status}`);
    const expPayout = b.status === 'WON' ? Math.floor(b.stake * b.combined_odds) : b.status === 'VOID' ? b.stake : 0;
    check(`${label}: payout`, b.payout === expPayout, `got ${b.payout} expected ${expPayout}`);
  }
  verifyPlayerBet(bBet, 'bob over');
  verifyPlayerBet(cBet, 'carol under');
  verifyPlayerBet(fBet, 'frank parlay');

  // matchup verification (synthetic)
  function verifyMatchupBet(bet, label, expStatus) {
    const b = betRow.get(bet.id);
    check(`${label}: ${expStatus}`, b.status === expStatus, `got ${b.status}`);
    const expPayout = expStatus === 'WON' ? Math.floor(b.stake * b.combined_odds) : 0;
    check(`${label}: payout`, b.payout === expPayout, `got ${b.payout} expected ${expPayout}`);
  }
  verifyMatchupBet(dBet, 'favorite ML (dog won)', 'LOST');
  verifyMatchupBet(eBet, 'dog ML (dog won)', 'WON');
  verifyMatchupBet(gBet, 'spread push (margin==line)', 'LOST');
  verifyMatchupBet(hBet, 'spread cover', 'WON');

  // ---------------- ledger reconciliation ----------------
  section('ledger reconciliation');
  const users = db.prepare('SELECT username FROM users').all().map((u) => u.username);
  let booksOk = true;
  for (const u of users) {
    const bal = db.prepare("SELECT COALESCE(SUM(delta),0) s FROM ledger WHERE username=? AND week=0").get(u).s;
    if (bal !== spendableBalance(u)) booksOk = false;
  }
  check('every balance == sum(ledger deltas)', booksOk);
  // every dollar accounted for: grants - stakes + payouts/refunds == sum of balances
  const tot = db.prepare("SELECT reason, COALESCE(SUM(delta),0) s FROM ledger GROUP BY reason").all();
  const by = Object.fromEntries(tot.map((r) => [r.reason, r.s]));
  const sumBal = users.reduce((s, u) => s + spendableBalance(u), 0);
  check('grants + stakes + payouts + refunds == total balance',
    (by.grant || 0) + (by.stake || 0) + (by.payout || 0) + (by.refund || 0) === sumBal,
    `grants ${by.grant||0} stakes ${by.stake||0} payouts ${by.payout||0} refunds ${by.refund||0} = bal ${sumBal}`);
  // house take = stakes paid in - payouts out (positive = house ahead on these settled bets)
  const houseTake = -(by.stake || 0) - (by.payout || 0) - (by.refund || 0);
  console.log(`  house net on settled action: ${houseTake >= 0 ? '+' : ''}${houseTake} (vig works over volume; one slate is variance)`);

  console.log(`\n${fail === 0 ? 'ALL GOOD' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
