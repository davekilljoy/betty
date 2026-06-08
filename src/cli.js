// Ops CLI:  node src/cli.js <ingest|settle|demo> [week]
const { ingest } = require('./sleeper');
const { settleWeek, freezeDue } = require('./settle');
const { currentPeriod, login, db, now } = require('./db');

async function main() {
  const cmd = process.argv[2];
  const week = process.argv[3] !== undefined ? Number(process.argv[3]) : currentPeriod();

  if (cmd === 'members') {
    // load the real Sleeper league members as users (so the leaderboard is the league)
    const { fetchMembers } = require('./league');
    const members = await fetchMembers();
    for (const m of members) login(m.username);
    console.log(`loaded ${members.length} league members:`, members.map((m) => m.username).join(', '));
  } else if (cmd === 'ingest') {
    await ingest({ week });
  } else if (cmd === 'settle') {
    freezeDue();
    console.log(await settleWeek(week));
  } else if (cmd === 'demo') {
    // seed a few members + some bets so the board isn't empty on first run
    await ingest({ week });
    for (const u of ['dave', 'sara', 'mike', 'jenna']) login(u);
    const rungs = db.prepare("SELECT id, market_id FROM rungs ORDER BY RANDOM() LIMIT 8").all();
    const insBet = db.prepare("INSERT INTO bets (username,week,type,stake,combined_odds,potential,status,placed_ts) VALUES (?,?,?,?,?,?,'OPEN',?)");
    const insLeg = db.prepare("INSERT INTO bet_legs (bet_id,market_id,player_name,side,threshold,odds,line) SELECT ?,r.market_id,m.player_name,r.side,r.threshold,r.odds,m.projection FROM rungs r JOIN markets m ON m.id=r.market_id WHERE r.id=?");
    const led = db.prepare("INSERT INTO ledger (username,week,delta,reason,bet_id,ts) VALUES (?,?,?,'stake',?,?)");
    const users = ['dave', 'sara', 'mike', 'jenna'];
    rungs.forEach((r, i) => {
      const u = users[i % users.length];
      const row = db.prepare('SELECT odds FROM rungs WHERE id=?').get(r.id);
      const stake = [50, 100, 150, 25][i % 4];
      const info = insBet.run(u, week, 'single', stake, row.odds, Math.floor(stake * row.odds), now());
      insLeg.run(info.lastInsertRowid, r.id);
      led.run(u, week, -stake, info.lastInsertRowid, now());
    });
    console.log('demo data seeded:', rungs.length, 'bets');
  } else {
    console.log('usage: node src/cli.js <ingest|settle|demo> [week]');
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
