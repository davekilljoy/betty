-- Betty schema. SQLite (better-sqlite3). Enums enforced via CHECK constraints.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  username    TEXT PRIMARY KEY,
  created_ts  INTEGER NOT NULL
);

-- Append-only money movements. Balance = SUM(delta). Never UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL REFERENCES users(username),
  week        INTEGER NOT NULL,
  delta       INTEGER NOT NULL,                 -- play-currency units (whole dollars)
  reason      TEXT NOT NULL CHECK (reason IN ('grant','stake','payout','refund')),
  bet_id      INTEGER,                          -- null for grants
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(username);

-- One market per (player, week, stat).
CREATE TABLE IF NOT EXISTS markets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  week         INTEGER NOT NULL,
  player_id    TEXT NOT NULL,
  player_name  TEXT NOT NULL,
  team         TEXT,
  position     TEXT NOT NULL,
  opponent     TEXT,                            -- opposing team abbr (null if bye/unknown)
  is_home      INTEGER NOT NULL DEFAULT 1,      -- 1 = home, 0 = away
  stat         TEXT NOT NULL CHECK (stat IN ('ppr_pts')),
  projection   REAL NOT NULL,
  kickoff_ts   INTEGER NOT NULL,                -- trading freezes here
  settle_after INTEGER NOT NULL,                -- earliest settle time
  status       TEXT NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN','FROZEN','SETTLING','SETTLED','VOID')),
  actual_value REAL,                            -- filled at settle
  created_ts   INTEGER NOT NULL,
  UNIQUE (week, player_id, stat)
);
CREATE INDEX IF NOT EXISTS idx_markets_week ON markets(week, status);

-- The ladder: each row is one bettable line with locked-in odds.
CREATE TABLE IF NOT EXISTS rungs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id    INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  side         TEXT NOT NULL CHECK (side IN ('OVER','UNDER')),
  threshold    REAL NOT NULL,
  odds         REAL NOT NULL,                   -- decimal odds (e.g. 1.91, 5.50)
  implied_prob REAL NOT NULL,
  UNIQUE (market_id, side, threshold)
);
CREATE INDEX IF NOT EXISTS idx_rungs_market ON rungs(market_id);

CREATE TABLE IF NOT EXISTS bets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL REFERENCES users(username),
  week          INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('single','parlay')),
  stake         INTEGER NOT NULL CHECK (stake > 0),
  combined_odds REAL NOT NULL,
  potential     INTEGER NOT NULL,               -- stake * combined_odds, floored
  status        TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','WON','LOST','VOID')),
  payout        INTEGER NOT NULL DEFAULT 0,
  placed_ts     INTEGER NOT NULL,
  settled_ts    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bets_feed ON bets(placed_ts DESC);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(username);

-- One row per leg. Single bet => 1 leg. Parlay => many. Snapshots are immutable.
CREATE TABLE IF NOT EXISTS bet_legs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_id        INTEGER NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  market_id     INTEGER NOT NULL REFERENCES markets(id),
  player_name   TEXT NOT NULL,                  -- denormalized for the feed
  side          TEXT NOT NULL CHECK (side IN ('OVER','UNDER')),
  threshold     REAL NOT NULL,
  odds          REAL NOT NULL,                  -- snapshot at placement
  line          REAL NOT NULL,                  -- projection snapshot at placement
  status        TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','WON','LOST','VOID')),
  actual_value  REAL
);
CREATE INDEX IF NOT EXISTS idx_legs_bet ON bet_legs(bet_id);
CREATE INDEX IF NOT EXISTS idx_legs_market ON bet_legs(market_id);
