// SQLite wrapper + the money/bankroll rules. Single-process, synchronous (better-sqlite3).
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.BETTY_DB || path.join(__dirname, '..', 'data', 'betty.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Reconcile databases created before bet_legs was generalized (player|matchup legs).
// CREATE TABLE IF NOT EXISTS won't alter an existing table, so rebuild it in place.
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(bet_legs)').all().map((c) => c.name);
  if (!cols.includes('leg_kind')) {
    db.exec(`
      ALTER TABLE bet_legs RENAME TO bet_legs_old;
      CREATE TABLE bet_legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bet_id INTEGER NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
        leg_kind TEXT NOT NULL DEFAULT 'player' CHECK (leg_kind IN ('player','matchup')),
        market_id INTEGER, matchup_id INTEGER, pick_roster INTEGER,
        player_name TEXT NOT NULL, side TEXT, threshold REAL, odds REAL NOT NULL, line REAL,
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','WON','LOST','VOID')),
        actual_value REAL
      );
      INSERT INTO bet_legs (id,bet_id,leg_kind,market_id,player_name,side,threshold,odds,line,status,actual_value)
        SELECT id,bet_id,'player',market_id,player_name,side,threshold,odds,line,status,actual_value FROM bet_legs_old;
      DROP TABLE bet_legs_old;
      CREATE INDEX IF NOT EXISTS idx_legs_bet ON bet_legs(bet_id);
      CREATE INDEX IF NOT EXISTS idx_legs_market ON bet_legs(market_id);
      CREATE INDEX IF NOT EXISTS idx_legs_matchup ON bet_legs(matchup_id);
    `);
    console.log('[db] migrated bet_legs to generalized (player|matchup) schema');
  }
})();

// bet_legs indexes, created after migrate() so the columns are guaranteed to exist.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_legs_bet ON bet_legs(bet_id);
  CREATE INDEX IF NOT EXISTS idx_legs_market ON bet_legs(market_id);
  CREATE INDEX IF NOT EXISTS idx_legs_matchup ON bet_legs(matchup_id);
`);

const WEEKLY_GRANT = Number(process.env.BETTY_GRANT || 1000);

// The active betting period. 0 = preseason/offseason lump; 1..18 = regular-season weeks.
// Driven by env in dev/offseason; a real season calendar plugs in here later.
function currentPeriod() {
  const w = process.env.BETTY_WEEK;
  if (w !== undefined && w !== '') return Number(w);
  return 0; // offseason default (it's the preseason lump window)
}

function now() {
  return Number(process.env.BETTY_NOW || Date.now());
}

function ensureUser(username) {
  db.prepare(
    'INSERT OR IGNORE INTO users (username, created_ts) VALUES (?, ?)'
  ).run(username, now());
}

// Idempotently grant the bankroll for the current period. Exactly one grant per
// (user, period) — that's what makes it "not stack": last period's grant lives in a
// different bucket and isn't counted toward this period's spendable balance.
const ensureGrant = db.transaction((username, period) => {
  const got = db
    .prepare("SELECT 1 FROM ledger WHERE username=? AND week=? AND reason='grant'")
    .get(username, period);
  if (!got) {
    db.prepare(
      "INSERT INTO ledger (username, week, delta, reason, ts) VALUES (?,?,?,'grant',?)"
    ).run(username, period, WEEKLY_GRANT, now());
  }
});

function login(username) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,20}$/.test(username)) {
    throw new Error('username must be 2-20 chars: a-z, 0-9, _');
  }
  ensureUser(username);
  ensureGrant(username, currentPeriod());
  return { username, balance: spendableBalance(username), pnl: seasonPnl(username) };
}

// Spendable this period only (does not stack across weeks).
function spendableBalance(username) {
  const row = db
    .prepare('SELECT COALESCE(SUM(delta),0) AS bal FROM ledger WHERE username=? AND week=?')
    .get(username, currentPeriod());
  return row.bal;
}

// Persistent season score: net of all bets, grants excluded.
function seasonPnl(username) {
  const row = db
    .prepare("SELECT COALESCE(SUM(delta),0) AS pnl FROM ledger WHERE username=? AND reason<>'grant'")
    .get(username);
  return row.pnl;
}

module.exports = {
  db,
  now,
  currentPeriod,
  WEEKLY_GRANT,
  ensureUser,
  ensureGrant,
  login,
  spendableBalance,
  seasonPnl,
};
