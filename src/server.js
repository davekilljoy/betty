// Betty server: one Fastify app serving the API, the live feed (SSE), and the static
// board. Single process; the poller/settler can run here on an interval or be triggered.
const path = require('path');
const Fastify = require('fastify');
const { db, now, currentPeriod, login, spendableBalance, seasonPnl } = require('./db');
const { ingest } = require('./sleeper');
const { ingestMatchups } = require('./matchups');
const { settleWeek, settleMatchups, freezeDue } = require('./settle');
const { legWinProb, coverProb } = require('./odds');
const { LEAGUE_ID } = require('./league');

const app = Fastify({ logger: false });
app.register(require('@fastify/static'), {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
});

// --- live feed (Server-Sent Events) -----------------------------------------
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.raw.write(payload);
}

app.get('/api/feed', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.write(`event: hello\ndata: ${JSON.stringify({ period: currentPeriod() })}\n\n`);
  clients.add(reply);
  req.raw.on('close', () => clients.delete(reply));
});

// --- auth (username only) ----------------------------------------------------
app.post('/api/login', async (req) => {
  const me = login(req.body?.username);
  return me;
});

// --- markets + ladders -------------------------------------------------------
const marketsForWeek = db.prepare(
  "SELECT * FROM markets WHERE week=? AND status='OPEN' ORDER BY projection DESC"
);
const rungsForMarket = db.prepare('SELECT * FROM rungs WHERE market_id=? ORDER BY side, threshold');

// The week shown on the board. In the preseason the bankroll period is 0, but we still
// want to show the upcoming week's markets — so this is decoupled from currentPeriod().
function displayWeek() {
  if (process.env.BETTY_MARKET_WEEK) return Number(process.env.BETTY_MARKET_WEEK);
  const row = db.prepare("SELECT MIN(week) AS w FROM markets WHERE status='OPEN'").get();
  return row.w ?? currentPeriod();
}

app.get('/api/markets', async (req) => {
  const week = req.query.week !== undefined ? Number(req.query.week) : displayWeek();
  const markets = marketsForWeek.all(week).map((m) => ({
    ...m,
    rungs: rungsForMarket.all(m.id),
  }));
  return { week, markets };
});

// --- matchups (H2H) ----------------------------------------------------------
const matchupsForWeek = db.prepare("SELECT * FROM matchups WHERE week=? AND status='OPEN' ORDER BY win_prob_a DESC");
const mrungsForMatchup = db.prepare('SELECT * FROM matchup_rungs WHERE matchup_id=? ORDER BY pick_roster, kind, spread');
app.get('/api/matchups', async (req) => {
  const week = req.query.week !== undefined ? Number(req.query.week) : displayWeek();
  const matchups = matchupsForWeek.all(week).map((m) => ({ ...m, rungs: mrungsForMatchup.all(m.id) }));
  return { week, matchups };
});

// --- placing bets (single + parlay; legs may be player props or matchup picks) ----
const getRung = db.prepare('SELECT r.*, m.status AS m_status, m.kickoff_ts, m.week, m.player_name, m.projection FROM rungs r JOIN markets m ON m.id=r.market_id WHERE r.id=?');
const getMRung = db.prepare(`SELECT mr.*, m.status AS m_status, m.kickoff_ts, m.week,
  m.roster_a, m.roster_b, m.manager_a, m.manager_b, m.proj_a, m.proj_b
  FROM matchup_rungs mr JOIN matchups m ON m.id=mr.matchup_id WHERE mr.id=?`);
const insBet = db.prepare(`INSERT INTO bets (username, week, type, stake, combined_odds, potential, status, placed_ts)
  VALUES (?,?,?,?,?,?, 'OPEN', ?)`);
const insLeg = db.prepare(`INSERT INTO bet_legs
  (bet_id, leg_kind, market_id, matchup_id, pick_roster, player_name, side, threshold, odds, line)
  VALUES (@bet_id,@leg_kind,@market_id,@matchup_id,@pick_roster,@player_name,@side,@threshold,@odds,@line)`);
const addLedger = db.prepare("INSERT INTO ledger (username, week, delta, reason, bet_id, ts) VALUES (?,?,?,'stake',?,?)");

const spreadText = (s) => (s > 0 ? `-${s}` : `+${-s}`);

const placeBet = db.transaction((username, stake, rungIds, mRungIds) => {
  if (!Number.isInteger(stake) || stake <= 0) throw new Error('stake must be a positive integer');
  const period = currentPeriod();
  const legs = [];

  for (const id of rungIds) {
    const r = getRung.get(id);
    if (!r) throw new Error(`unknown line ${id}`);
    if (r.m_status !== 'OPEN' || r.kickoff_ts <= now()) throw new Error(`${r.player_name} is closed for betting`);
    legs.push({
      leg_kind: 'player', market_id: r.market_id, matchup_id: null, pick_roster: null,
      player_name: r.player_name, side: r.side, threshold: r.threshold, odds: r.odds,
      line: r.projection, dedupe: `p${r.market_id}`,
    });
  }
  for (const id of mRungIds) {
    const r = getMRung.get(id);
    if (!r) throw new Error(`unknown matchup line ${id}`);
    if (r.m_status !== 'OPEN' || r.kickoff_ts <= now()) throw new Error('that matchup is closed for betting');
    const onA = r.pick_roster === r.roster_a;
    const pickName = onA ? r.manager_a : r.manager_b;
    const projMargin = onA ? r.proj_a - r.proj_b : r.proj_b - r.proj_a;
    legs.push({
      leg_kind: 'matchup', market_id: null, matchup_id: r.matchup_id, pick_roster: r.pick_roster,
      player_name: r.kind === 'ml' ? `${pickName} ML` : `${pickName} ${spreadText(r.spread)}`,
      side: r.kind === 'ml' ? 'ML' : 'SPREAD', threshold: r.spread, odds: r.odds,
      line: Math.round(projMargin * 10) / 10, dedupe: `m${r.matchup_id}`,
    });
  }
  if (legs.length === 0) throw new Error('pick at least one line');

  // can't include the same player or matchup twice in one parlay
  const seen = new Set();
  for (const l of legs) {
    if (seen.has(l.dedupe)) throw new Error('a parlay can only include each player or matchup once');
    seen.add(l.dedupe);
  }
  const bal = spendableBalance(username);
  if (stake > bal) throw new Error(`insufficient balance ($${bal})`);

  const combined = legs.reduce((acc, l) => acc * l.odds, 1);
  const potential = Math.floor(stake * combined);
  const type = legs.length > 1 ? 'parlay' : 'single';
  const info = insBet.run(username, period, type, stake, round2(combined), potential, now());
  const betId = info.lastInsertRowid;
  for (const { dedupe, ...l } of legs) insLeg.run({ bet_id: betId, ...l });
  addLedger.run(username, period, -stake, betId, now());
  return betId;
});

const feedBet = db.prepare('SELECT * FROM bets WHERE id=?');
const feedLegs = db.prepare('SELECT leg_kind, market_id, matchup_id, pick_roster, player_name, side, threshold, odds, line, status, actual_value FROM bet_legs WHERE bet_id=?');

// --- cash out (early exit at current value minus a penalty) -------------------
const CASHOUT_PENALTY = Number(process.env.BETTY_CASHOUT_PENALTY || 0.10);
const marketLite = db.prepare('SELECT projection, position, status FROM markets WHERE id=?');
const matchupLite = db.prepare('SELECT proj_a, proj_b, roster_a, status FROM matchups WHERE id=?');

// Re-price an open bet against the CURRENT lines. Returns {available, value, winProb}.
// Unavailable once any leg's market/matchup has frozen (no live re-pricing mid-game).
function cashoutQuote(bet, legs) {
  if (bet.status !== 'OPEN') return { available: false, value: null };
  let prob = 1;
  for (const l of legs) {
    if (l.leg_kind === 'player') {
      const m = marketLite.get(l.market_id);
      if (!m || m.status !== 'OPEN') return { available: false, value: null };
      prob *= legWinProb(m.projection, m.position, l.side, l.threshold);
    } else {
      const mu = matchupLite.get(l.matchup_id);
      if (!mu || mu.status !== 'OPEN') return { available: false, value: null };
      const pickProj = l.pick_roster === mu.roster_a ? mu.proj_a : mu.proj_b;
      const oppProj = l.pick_roster === mu.roster_a ? mu.proj_b : mu.proj_a;
      prob *= coverProb(pickProj, oppProj, l.threshold);
    }
  }
  const value = Math.max(0, Math.floor(bet.potential * prob * (1 - CASHOUT_PENALTY)));
  return { available: true, value, winProb: Math.round(prob * 1000) / 1000 };
}

const setCashed = db.prepare("UPDATE bets SET status='CASHED', payout=?, settled_ts=? WHERE id=? AND status='OPEN'");
const voidLegsForBet = db.prepare("UPDATE bet_legs SET status='VOID' WHERE bet_id=?");
const addPayout = db.prepare("INSERT INTO ledger (username, week, delta, reason, bet_id, ts) VALUES (?,?,?,'payout',?,?)");

const cashOut = db.transaction((betId, username) => {
  const bet = feedBet.get(betId);
  if (!bet) throw new Error('no such bet');
  if (bet.username !== username) throw new Error('not your bet');
  if (bet.status !== 'OPEN') throw new Error('bet is already settled');
  const legs = feedLegs.all(betId);
  const q = cashoutQuote(bet, legs);
  if (!q.available) throw new Error('cash out unavailable (a line is locked)');
  const r = setCashed.run(q.value, now(), betId);
  if (r.changes === 0) throw new Error('bet is already settled');
  voidLegsForBet.run(betId);                       // legs settled early; skip grading
  addPayout.run(username, bet.week, q.value, betId, now());
  return q.value;
});

app.post('/api/bets/:id/cashout', async (req, reply) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!username) return reply.code(400).send({ error: 'login first' });
  try {
    const value = cashOut(Number(req.params.id), username);
    const bet = { ...feedBet.get(Number(req.params.id)), legs: feedLegs.all(Number(req.params.id)) };
    broadcast('bet', bet);
    return { ok: true, value, balance: spendableBalance(username) };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

app.post('/api/bets', async (req, reply) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!username) return reply.code(400).send({ error: 'login first' });
  login(username); // ensures grant exists
  const stake = Number(req.body?.stake);
  const rungIds = (req.body?.rungIds || []).map(Number);
  const mRungIds = (req.body?.mRungIds || []).map(Number);
  if (rungIds.length === 0 && mRungIds.length === 0) return reply.code(400).send({ error: 'pick at least one line' });
  try {
    const betId = placeBet(username, stake, rungIds, mRungIds);
    const bet = { ...feedBet.get(betId), legs: feedLegs.all(betId) };
    broadcast('bet', bet);
    return { ok: true, bet, balance: spendableBalance(username) };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

// --- the public feed ---------------------------------------------------------
const recentBets = db.prepare('SELECT * FROM bets ORDER BY placed_ts DESC LIMIT ?');
app.get('/api/bets', async (req) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const me = String(req.query.username || '').trim().toLowerCase();
  return recentBets.all(limit).map((b) => {
    const legs = feedLegs.all(b.id);
    // expose a live cash-out value only on the requester's own open bets
    const cashout = me && b.username === me && b.status === 'OPEN'
      ? cashoutQuote(b, legs).value : undefined;
    return { ...b, legs, cashout };
  });
});

// --- leaderboard (season P&L) ------------------------------------------------
app.get('/api/leaderboard', async () => {
  const rows = db
    .prepare(`SELECT u.username,
                COALESCE(SUM(CASE WHEN l.reason<>'grant' THEN l.delta END),0) AS pnl,
                COALESCE(SUM(CASE WHEN l.week=@p THEN l.delta END),0) AS balance
              FROM users u LEFT JOIN ledger l ON l.username=u.username
              GROUP BY u.username ORDER BY pnl DESC`)
    .all({ p: currentPeriod() });
  return { period: currentPeriod(), rows };
});

app.get('/api/me', async (req) => {
  const username = String(req.query.username || '').trim().toLowerCase();
  if (!username) return { username: null };
  return { username, balance: spendableBalance(username), pnl: seasonPnl(username), period: currentPeriod() };
});

// --- admin / ops endpoints (local) -------------------------------------------
app.post('/api/admin/ingest', async (req) => {
  const week = Number(req.body?.week ?? displayWeek());
  return { players: await ingest({ week }), matchups: await ingestMatchups({ week }) };
});
app.post('/api/admin/settle', async (req) => {
  const week = Number(req.body?.week ?? currentPeriod());
  freezeDue();
  return { players: await settleWeek(week), matchups: await settleMatchups(week) };
});

// --- adaptive polling: cadence scales with how close we are to live games -----
// Phase comes from the displayed week's kickoff/settle windows (no extra fetch):
//   live     = a game window is in progress  -> poll fast (freeze + settle)
//   gameweek = games are within ~4 days      -> refresh lines, freeze at kickoff
//   offseason= nothing close                 -> slow line refresh only
const minKick = db.prepare("SELECT MIN(kickoff_ts) AS mn, MAX(settle_after) AS mx FROM markets WHERE week=? AND status IN ('OPEN','FROZEN')");
function computePhase() {
  const row = minKick.get(displayWeek());
  if (!row || !row.mn) return 'offseason';
  const t = now();
  if (t >= row.mn && t <= row.mx) return 'live';
  if (row.mn - t <= 4 * 24 * 3600 * 1000) return 'gameweek';
  return 'offseason';
}
const PHASE = {
  offseason: { tick: 6 * 3600e3, ingest: 12 * 3600e3, settle: false },
  gameweek:  { tick: 20 * 60e3,  ingest: 20 * 60e3,   settle: false },
  live:      { tick: 60e3,       ingest: 15 * 60e3,   settle: true },
};

function startBackground() {
  const noPoll = process.env.BETTY_AUTOPOLL === '0';
  const noSettle = process.env.BETTY_AUTOSETTLE === '0';
  if (noPoll && noSettle) { console.log('[bg] background polling disabled'); return; }
  let lastIngest = 0;
  const run = async () => {
    let delay = PHASE.offseason.tick;
    try {
      const phase = computePhase();
      const cfg = PHASE[phase];
      delay = Number(process.env.BETTY_TICK_MS) || cfg.tick;
      freezeDue();
      if (!noPoll && now() - lastIngest >= cfg.ingest) {
        const wk = displayWeek();
        await ingest({ week: wk });
        await ingestMatchups({ week: wk });
        lastIngest = now();
      }
      if (cfg.settle && !noSettle) {
        await settleWeek(currentPeriod());
        await settleMatchups(currentPeriod());
      }
      broadcast('tick', { phase, ts: now() });
    } catch (e) {
      console.warn('[bg] tick error:', e.message);
    } finally {
      setTimeout(run, delay);
    }
  };
  console.log('[bg] adaptive polling started');
  setTimeout(run, 1000);
}

// First-boot seeding: on a fresh volume the board is empty, so ingest the display week
// and load the real league members. Idempotent — skips ingest if markets already exist.
async function bootstrap() {
  if (process.env.BETTY_AUTOSEED === '0') return;
  try {
    const wk = displayWeek();
    const have = db.prepare("SELECT COUNT(*) AS c FROM markets WHERE week=? AND status='OPEN'").get(wk).c;
    if (have === 0) {
      console.log(`[boot] empty board — ingesting week ${wk}`);
      await ingest({ week: wk });
    }
    const haveM = db.prepare("SELECT COUNT(*) AS c FROM matchups WHERE week=? AND status='OPEN'").get(wk).c;
    if (haveM === 0) {
      console.log(`[boot] no matchups — ingesting H2H week ${wk}`);
      await ingestMatchups({ week: wk });
    }
    const { fetchMembers } = require('./league');
    const members = await fetchMembers();
    for (const m of members) login(m.username);
    console.log(`[boot] ${members.length} league members loaded`);
  } catch (e) {
    console.warn('[boot] bootstrap skipped:', e.message);
  }
}

async function start() {
  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`betty up on :${port}  (league ${LEAGUE_ID}, period ${currentPeriod()})`);
  await bootstrap();
  startBackground();
}

function round2(x) { return Math.round(x * 100) / 100; }

if (require.main === module) start();
module.exports = { app, start, broadcast };
