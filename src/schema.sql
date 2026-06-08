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

-- Manager-vs-manager (H2H) markets. One row per league matchup per week.
CREATE TABLE IF NOT EXISTS matchups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  week         INTEGER NOT NULL,
  matchup_id   INTEGER NOT NULL,                -- sleeper's pairing id
  roster_a     INTEGER NOT NULL,
  roster_b     INTEGER NOT NULL,
  manager_a    TEXT NOT NULL,
  manager_b    TEXT NOT NULL,
  avatar_a     TEXT,
  avatar_b     TEXT,
  proj_a       REAL NOT NULL,
  proj_b       REAL NOT NULL,
  win_prob_a   REAL NOT NULL,                   -- projected P(A wins)
  kickoff_ts   INTEGER NOT NULL,
  settle_after INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN','FROZEN','SETTLING','SETTLED','VOID')),
  actual_a     REAL,
  actual_b     REAL,
  winner       INTEGER,                          -- roster_id of winner (null until settled)
  created_ts   INTEGER NOT NULL,
  UNIQUE (week, matchup_id)
);
CREATE INDEX IF NOT EXISTS idx_matchups_week ON matchups(week, status);

-- Bettable lines on a matchup: moneyline + alternate spreads, per side.
CREATE TABLE IF NOT EXISTS matchup_rungs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  matchup_id   INTEGER NOT NULL REFERENCES matchups(id) ON DELETE CASCADE,
  pick_roster  INTEGER NOT NULL,                -- which roster you're backing
  kind         TEXT NOT NULL CHECK (kind IN ('ml','spread')),
  spread       REAL NOT NULL,                   -- pick must win by more than this (ml => 0)
  odds         REAL NOT NULL,
  implied_prob REAL NOT NULL,
  UNIQUE (matchup_id, pick_roster, kind, spread)
);
CREATE INDEX IF NOT EXISTS idx_mrungs_matchup ON matchup_rungs(matchup_id);

-- One row per leg. Single bet => 1 leg. Parlay => many. A leg is either a player prop
-- (kind='player', references markets) or a matchup pick (kind='matchup', references
-- matchups). Snapshots are immutable. NOTE: the live schema is reconciled by migrate()
-- in db.js for databases created before this was generalized.
CREATE TABLE IF NOT EXISTS bet_legs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_id        INTEGER NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  leg_kind      TEXT NOT NULL DEFAULT 'player' CHECK (leg_kind IN ('player','matchup')),
  market_id     INTEGER,                        -- player legs
  matchup_id    INTEGER,                        -- matchup legs
  pick_roster   INTEGER,                        -- matchup legs: backed roster
  player_name   TEXT NOT NULL,                  -- label for the feed (player or manager)
  side          TEXT,                           -- player: OVER/UNDER; matchup: ML or spread text
  threshold     REAL,                           -- player: line; matchup: spread
  odds          REAL NOT NULL,                  -- snapshot at placement
  line          REAL,                           -- player: projection; matchup: projected margin
  status        TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','WON','LOST','VOID')),
  actual_value  REAL
);
-- bet_legs indexes are created in db.js AFTER migrate(), since on an old database the
-- matchup_id/etc columns don't exist until the table is rebuilt.
