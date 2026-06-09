// Betty board client. Vanilla JS, no build step.
const $ = (s) => document.querySelector(s);
const api = (p, opts) => fetch(p, opts).then((r) => r.json());
const AV = (id) => `https://sleepercdn.com/content/nfl/players/thumb/${id}.jpg`;
const LOGO = (t) => `https://sleepercdn.com/images/team_logos/nfl/${String(t).toLowerCase()}.png`;

const MAV = (a) => (a ? `https://sleepercdn.com/avatars/thumbs/${a}` : null); // manager avatar

let me = localStorage.getItem('betty_user') || null;
let mode = 'players';            // 'players' | 'managers'
let allMarkets = [];
let allMatchups = [];
const slip = new Map();  // player rungId -> {player_name, side, threshold, odds}
const mslip = new Map(); // matchup rungId -> {label, odds, matchup_id, pick_roster}
const filters = { pos: 'ALL', team: '', sort: 'proj_desc', search: '', game: null };
const POS_ORDER = ['QB', 'RB', 'WR', 'TE'];

// --- formatting ---
const american = (d) => (d >= 2 ? `+${Math.round((d - 1) * 100)}` : `${Math.round(-100 / (d - 1))}`);
const money = (n) => `$${Math.abs(Math.round(n)).toLocaleString()}`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${money(n)}`;
const initials = (s) => s.split(/[\s_]+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- auth ---
async function doLogin(name) {
  const r = await api('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name }),
  });
  if (r.error) { $('#username').focus(); return alert(r.error); }
  me = r.username; localStorage.setItem('betty_user', me);
  renderWallet(r); loadLeaderboard();
}
function renderWallet(m) {
  $('#who').classList.add('hidden');
  $('#wallet').classList.remove('hidden');
  $('#meName').textContent = m.username;
  $('#meBal').textContent = money(m.balance);
  const pnl = m.pnl || 0;
  const el = $('#mePnl');
  el.textContent = signed(pnl);
  el.className = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : '';
}
async function refreshMe() {
  if (!me) return;
  renderWallet(await api(`/api/me?username=${encodeURIComponent(me)}`));
}
$('#loginBtn').onclick = () => { const v = $('#username').value.trim(); if (v) doLogin(v); };
$('#username').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });
$('#logoutBtn').onclick = () => {
  me = null; localStorage.removeItem('betty_user');
  $('#wallet').classList.add('hidden'); $('#who').classList.remove('hidden');
  $('#username').value = ''; loadLeaderboard();
};

// --- board ---
async function loadMarkets() {
  const { week, markets } = await api('/api/markets');
  allMarkets = markets;
  $('#weekTag').textContent = week === 0 ? 'preseason' : `week ${week}`;
  // populate team filter
  const teams = [...new Set(markets.map((m) => m.team).filter(Boolean))].sort();
  $('#teamFilter').innerHTML = '<option value="">all teams</option>' +
    teams.map((t) => `<option value="${t}">${t}</option>`).join('');
  renderGamesStrip();
  renderBoard();
}

// derive the week's games from market data (each market knows its team + opponent + home)
function deriveGames() {
  const map = new Map();
  for (const m of allMarkets) {
    if (!m.team || !m.opponent) continue;
    const home = m.is_home ? m.team : m.opponent;
    const away = m.is_home ? m.opponent : m.team;
    const key = `${away}@${home}`;
    if (!map.has(key)) map.set(key, { key, home, away, kickoff: m.kickoff_ts });
  }
  return [...map.values()].sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0) || a.away.localeCompare(b.away));
}
const dayLabel = (ts) => ts ? new Date(ts).toLocaleDateString(undefined, { weekday: 'short' }) : '';
function gameChip(g) {
  const sel = filters.game === g.key ? ' sel' : '';
  return `<button class="game${sel}" data-key="${g.key}" title="${g.away} @ ${g.home} · ${dayLabel(g.kickoff)}">
    <img class="gl" width="20" height="20" src="${LOGO(g.away)}" loading="lazy" onerror="this.style.visibility='hidden'" alt="">
    <span class="ga">${g.away}</span><span class="at">@</span><span class="gh">${g.home}</span>
    <img class="gl" width="20" height="20" src="${LOGO(g.home)}" loading="lazy" onerror="this.style.visibility='hidden'" alt="">
  </button>`;
}
function renderGamesStrip() {
  const games = deriveGames();
  const el = $('#gamesStrip');
  if (!games.length) { el.innerHTML = ''; return; }
  el.innerHTML = games.map(gameChip).join('');
  el.querySelectorAll('.game').forEach((b) => (b.onclick = () => {
    filters.game = filters.game === b.dataset.key ? null : b.dataset.key;
    renderGamesStrip(); renderBoard();
  }));
}

function renderBoard() {
  const game = filters.game ? deriveGames().find((g) => g.key === filters.game) : null;
  let rows = allMarkets.filter((m) => {
    if (filters.pos !== 'ALL' && m.position !== filters.pos) return false;
    if (filters.team && m.team !== filters.team) return false;
    if (game && m.team !== game.home && m.team !== game.away) return false;
    if (filters.search && !m.player_name.toLowerCase().includes(filters.search)) return false;
    return true;
  });
  const cmp = {
    proj_desc: (a, b) => b.projection - a.projection,
    proj_asc: (a, b) => a.projection - b.projection,
    name: (a, b) => a.player_name.localeCompare(b.player_name),
    team: (a, b) => (a.team || 'zz').localeCompare(b.team || 'zz') || b.projection - a.projection,
  }[filters.sort];
  rows.sort(cmp);

  $('#marketCount').textContent = `${rows.length} market${rows.length === 1 ? '' : 's'}`;
  const el = $('#markets');
  if (!rows.length) {
    el.innerHTML = '<div class="board-empty">No players match those filters.</div>';
    return;
  }
  // group by position with subheadings
  const groups = {};
  for (const m of rows) (groups[m.position] ||= []).push(m);
  el.innerHTML = POS_ORDER.filter((p) => groups[p]?.length).map((p) => `
    <div class="pos-group">
      <h3 class="pos-sub"><span class="pos ${p.toLowerCase()}">${p}</span><span class="cnt">${groups[p].length}</span></h3>
      ${groups[p].map(renderMarket).join('')}
    </div>`).join('');
  el.querySelectorAll('.rung').forEach((r) => (r.onclick = () => toggleRung(r)));
  requestAnimationFrame(() => requestAnimationFrame(centerLadders));
}

// on mobile the ladder scrolls horizontally — start it centered on the projection.
// the ladder is symmetric (≈equal unders/overs around the line), so half the overflow
// lands the projection dead center.
function centerLadders() {
  document.querySelectorAll('#markets .ladder').forEach((l) => {
    const over = l.scrollWidth - l.clientWidth;
    if (over > 8) l.scrollLeft = over / 2; // 0 (no overflow) on desktop = no-op
  });
}
window.addEventListener('resize', centerLadders);

function rungChip(m, r) {
  const sel = slip.has(r.id) ? ' sel' : '';
  return `<button class="rung ${r.side.toLowerCase()}${sel}" data-id="${r.id}"
      data-name="${esc(m.player_name)}" data-side="${r.side}" data-th="${r.threshold}" data-odds="${r.odds}">
      <span class="ln">${r.side === 'OVER' ? 'o' : 'u'}${r.threshold}</span>
      <span class="od">${american(r.odds)}</span></button>`;
}

function renderMarket(m) {
  const unders = m.rungs.filter((r) => r.side === 'UNDER').sort((a, b) => a.threshold - b.threshold);
  const overs = m.rungs.filter((r) => r.side === 'OVER').sort((a, b) => a.threshold - b.threshold);
  const pos = m.position.toLowerCase();
  const logo = m.team ? `<img class="teamlogo" width="18" height="18" src="${LOGO(m.team)}" loading="lazy" onerror="this.remove()" alt="">` : '';
  const opp = m.opponent
    ? `<span class="opp"><span class="vs">${m.is_home ? 'vs' : '@'}</span><img class="opplogo" width="16" height="16" src="${LOGO(m.opponent)}" loading="lazy" onerror="this.style.display='none'" alt="">${m.opponent}</span>`
    : '<span class="opp bye">BYE</span>';
  return `<div class="market">
    <div class="player">
      <span class="avatar ${pos}">${initials(m.player_name)}
        <img class="face" src="${AV(m.player_id)}" loading="lazy" decoding="async" onerror="this.remove()" alt="">
      </span>
      <span class="pinfo">
        <span class="pname">${esc(m.player_name)}</span>
        <span class="pmeta">
          ${logo}<span class="pteam">${m.team || 'FA'}</span>
          ${opp}
        </span>
      </span>
    </div>
    <div class="ladder">
      <div class="side unders">${unders.map((r) => rungChip(m, r)).join('')}</div>
      <div class="line"><span class="v">${m.projection}</span><span class="lbl">proj</span></div>
      <div class="side overs">${overs.map((r) => rungChip(m, r)).join('')}</div>
    </div>
  </div>`;
}

// Surgical selection — toggle the chip's class only. NO board re-render (which would
// reload avatars and reset ladder scroll). renderMarket() reapplies .sel on filter changes.
function toggleRung(el) {
  const id = Number(el.dataset.id);
  if (slip.has(id)) {
    slip.delete(id);
    el.classList.remove('sel');
  } else {
    // one line per player: drop any existing leg on the same player (slip + its chip)
    for (const [rid, leg] of slip) {
      if (leg.player_name === el.dataset.name) {
        slip.delete(rid);
        document.querySelector(`.rung[data-id="${rid}"]`)?.classList.remove('sel');
      }
    }
    slip.set(id, { player_name: el.dataset.name, side: el.dataset.side, threshold: Number(el.dataset.th), odds: Number(el.dataset.odds) });
    el.classList.add('sel');
  }
  renderSlip();
}

// remove all selected-chip highlighting without rebuilding the board
function clearSelections() {
  document.querySelectorAll('.rung.sel, .pickchip.sel').forEach((e) => e.classList.remove('sel'));
}

// --- controls ---
$('#posFilter').querySelectorAll('.seg').forEach((b) => (b.onclick = () => {
  $('#posFilter .seg.active')?.classList.remove('active');
  b.classList.add('active'); filters.pos = b.dataset.pos; renderBoard();
}));
$('#teamFilter').onchange = (e) => { filters.team = e.target.value; renderBoard(); };
$('#sortBy').onchange = (e) => { filters.sort = e.target.value; renderBoard(); };
$('#search').oninput = (e) => { filters.search = e.target.value.trim().toLowerCase(); renderBoard(); };

// --- mode switch: players <-> managers ---
$('#modeSwitch').querySelectorAll('.mode').forEach((b) => (b.onclick = () => {
  if (mode === b.dataset.mode) return;
  $('#modeSwitch .mode.active')?.classList.remove('active');
  b.classList.add('active');
  mode = b.dataset.mode;
  $('#playersView').classList.toggle('hidden', mode !== 'players');
  $('#managersView').classList.toggle('hidden', mode !== 'managers');
  $('#boardTitle').firstChild.textContent = mode === 'players' ? 'The Board ' : 'Matchups ';
  $('#weekTag').classList.toggle('hidden', mode !== 'players');
  if (mode === 'managers') renderMatchups(); else renderBoard();
}));

// --- matchups (H2H) board ---
async function loadMatchups() {
  const { matchups } = await api('/api/matchups');
  allMatchups = matchups;
  if (mode === 'managers') renderMatchups();
}
function mChip(m, r, name) {
  const line = r.kind === 'ml' ? 'ML' : (r.spread > 0 ? `-${r.spread}` : `+${-r.spread}`);
  const sel = mslip.has(r.id) ? ' sel' : '';
  return `<button class="pickchip${sel}${r.kind === 'ml' ? ' ml' : ''}" data-id="${r.id}" data-mcard="${m.id}"
      data-name="${esc(name)}" data-line="${line}" data-odds="${r.odds}">
      <span class="pl">${line}</span><span class="po">${american(r.odds)}</span></button>`;
}
function managerRow(m, side) {
  const isA = side === 'A';
  const name = isA ? m.manager_a : m.manager_b;
  const av = isA ? m.avatar_a : m.avatar_b;
  const roster = isA ? m.roster_a : m.roster_b;
  const proj = isA ? m.proj_a : m.proj_b;
  const pct = Math.round((isA ? m.win_prob_a : 1 - m.win_prob_a) * 100);
  const fav = pct >= 50 ? ' fav' : '';
  const rungs = m.rungs.filter((r) => r.pick_roster === roster)
    .sort((a, b) => (a.kind === 'ml' ? -1 : b.kind === 'ml' ? 1 : a.spread - b.spread));
  const avatar = `<span class="mav">${esc(initials(name))}${av ? `<img class="face" src="${MAV(av)}" loading="lazy" onerror="this.remove()" alt="">` : ''}</span>`;
  return `<div class="mteam">
    <div class="minfo">${avatar}
      <div class="mname-wrap"><span class="mname">${esc(name)}</span>
        <span class="mproj">${proj} proj<span class="mpct${fav}">${pct}%</span></span></div>
    </div>
    <div class="mchips">${rungs.map((r) => mChip(m, r, name)).join('')}</div>
  </div>`;
}
function renderMatchups() {
  const el = $('#matchups');
  $('#marketCount').textContent = `${allMatchups.length} matchup${allMatchups.length === 1 ? '' : 's'}`;
  el.innerHTML = allMatchups.length
    ? allMatchups.map((m) => `<div class="matchup">${managerRow(m, 'A')}<div class="mdivider"><span>vs</span></div>${managerRow(m, 'B')}</div>`).join('')
    : '<div class="board-empty">No matchups scheduled this week.</div>';
  el.querySelectorAll('.pickchip').forEach((c) => (c.onclick = () => toggleMRung(c)));
}
function toggleMRung(el) {
  const id = Number(el.dataset.id);
  if (mslip.has(id)) { mslip.delete(id); el.classList.remove('sel'); }
  else {
    const card = el.dataset.mcard;       // one pick per matchup
    for (const [rid, leg] of mslip) {
      if (leg.mcard === card) { mslip.delete(rid); document.querySelector(`.pickchip[data-id="${rid}"]`)?.classList.remove('sel'); }
    }
    mslip.set(id, { name: el.dataset.name, line: el.dataset.line, odds: Number(el.dataset.odds), mcard: card });
    el.classList.add('sel');
  }
  renderSlip();
}

// --- bet slip (player props + matchup picks) ---
const combinedOdds = () => [...slip.values(), ...mslip.values()].reduce((a, l) => a * l.odds, 1);
function slipEntries() {
  return [
    ...[...slip].map(([id, l]) => ({ id, kind: 'p',
      player: esc(l.player_name), line: `${l.side === 'OVER' ? 'o' : 'u'}${l.threshold}`,
      lineCls: l.side === 'OVER' ? 'ov' : 'un', odds: l.odds })),
    ...[...mslip].map(([id, l]) => ({ id, kind: 'm',
      player: esc(l.name), line: l.line, lineCls: 'mm', odds: l.odds })),
  ];
}
function renderSlip() {
  const box = $('#slip');
  const entries = slipEntries();
  if (entries.length === 0) return box.classList.add('hidden');
  box.classList.remove('hidden');
  $('#slipTitle').textContent = entries.length > 1 ? `${entries.length}-Leg Parlay` : 'Bet Slip';
  $('#slipLegs').innerHTML = entries.map((e) => `
    <div class="slleg">
      <span class="sl-main">
        <span class="sl-player">${e.player}</span>
        <span class="sl-line"><span class="${e.lineCls}">${e.line}</span></span>
      </span>
      <span class="sl-od">${american(e.odds)}</span>
      <span class="x" data-id="${e.id}" data-kind="${e.kind}" title="remove">✕</span>
    </div>`).join('');
  $('#slipLegs').querySelectorAll('.x').forEach((x) => (x.onclick = () => {
    const id = Number(x.dataset.id);
    if (x.dataset.kind === 'm') { mslip.delete(id); document.querySelector(`.pickchip[data-id="${id}"]`)?.classList.remove('sel'); }
    else { slip.delete(id); document.querySelector(`.rung[data-id="${id}"]`)?.classList.remove('sel'); }
    renderSlip();
  }));
  $('#slipOdds').textContent = american(combinedOdds());
  updateToWin();
}
function updateToWin() {
  const stake = Number($('#stake').value) || 0;
  $('#slipToWin').textContent = stake ? money(stake * combinedOdds()) : '—';
}
$('#stake').addEventListener('input', updateToWin);
$('#slipClear').onclick = () => { slip.clear(); mslip.clear(); clearSelections(); renderSlip(); };
$('.quickstakes').addEventListener('click', (e) => {
  const q = e.target.dataset.q; if (!q) return;
  if (q === 'max') { $('#stake').value = Math.max(0, Math.floor(Number($('#meBal').textContent.replace(/[^0-9.-]/g, '')) || 0)); }
  else $('#stake').value = q;
  updateToWin();
});
$('#placeBtn').onclick = async () => {
  $('#slipErr').textContent = '';
  if (!me) { $('#slipErr').textContent = 'enter a username first'; return; }
  const stake = Math.floor(Number($('#stake').value));
  if (!stake || stake < 1) { $('#slipErr').textContent = 'enter a stake'; return; }
  const r = await api('/api/bets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: me, stake, rungIds: [...slip.keys()], mRungIds: [...mslip.keys()] }),
  });
  if (r.error) { $('#slipErr').textContent = r.error; return; }
  slip.clear(); mslip.clear(); $('#stake').value = ''; clearSelections(); renderSlip();
  $('#meBal').textContent = money(r.balance); refreshMe(); loadFeed(); loadLeaderboard();
};

// --- feed ---
function feedItem(b) {
  const cls = b.status === 'OPEN' ? '' : b.status;
  const legs = b.legs.map((l) => {
    const res = l.actual_value != null ? ` <span class="res">(${l.actual_value})</span>` : '';
    if (l.leg_kind === 'matchup') return `<span class="mm">${esc(l.player_name)}</span> ${american(l.odds)}${res}`;
    const s = l.side === 'OVER' ? 'ov' : 'un';
    return `${esc(l.player_name)} <span class="${s}">${l.side === 'OVER' ? 'o' : 'u'}${l.threshold}</span> ${american(l.odds)}${res}`;
  }).join('<span class="plus">+</span>');
  let amt = `<span class="amt">${money(b.stake)} · ${american(b.combined_odds)}</span>`;
  if (b.status === 'WON') amt = `<span class="amt win">${signed(b.payout)}</span>`;
  else if (b.status === 'LOST') amt = `<span class="amt lose">${signed(-b.stake)}</span>`;
  else if (b.status === 'VOID') amt = `<span class="amt void">refunded</span>`;
  else if (b.status === 'CASHED') amt = `<span class="amt cashed">cashed ${signed(b.payout - b.stake)}</span>`;
  const pill = b.type === 'parlay' ? `<span class="pill parlay">${b.legs.length}-leg</span>` : '';
  const cash = (b.username === me && b.status === 'OPEN' && b.cashout != null)
    ? `<button class="cashbtn" data-id="${b.id}">cash out <b>${money(b.cashout)}</b></button>` : '';
  return `<div class="item ${cls}">
    <div class="row1">
      <span class="fav">${esc(initials(b.username))}</span>
      <span class="u">${esc(b.username)}</span>${pill}${amt}
    </div>
    <div class="legline">${legs}</div>${cash}
  </div>`;
}
async function loadFeed() {
  const bets = await api(`/api/bets?limit=50&username=${encodeURIComponent(me || '')}`);
  $('#feed').innerHTML = bets.length ? bets.map(feedItem).join('') : '<div class="empty">No bets yet. Be the first degenerate.</div>';
}
async function cashOut(id) {
  if (!me) return;
  const r = await api(`/api/bets/${id}/cashout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: me }),
  });
  if (r.error) return alert(r.error);
  $('#meBal').textContent = money(r.balance);
  refreshMe(); loadFeed(); loadLeaderboard();
}
$('#feed').addEventListener('click', (e) => {
  const btn = e.target.closest('.cashbtn');
  if (btn) cashOut(Number(btn.dataset.id));
});
function connectFeed() {
  const es = new EventSource('/api/feed');
  es.addEventListener('bet', (e) => {
    const empty = $('#feed .empty'); if (empty) empty.remove();
    $('#feed').insertAdjacentHTML('afterbegin', feedItem(JSON.parse(e.data)));
  });
  es.addEventListener('tick', () => { loadFeed(); loadLeaderboard(); refreshMe(); });
}

// --- leaderboard ---
async function loadLeaderboard() {
  const { rows } = await api('/api/leaderboard');
  $('#leaderboard').innerHTML = rows.map((r, i) => {
    const k = r.pnl > 0 ? 'pos' : r.pnl < 0 ? 'neg' : 'flat';
    return `<li class="${r.username === me ? 'me' : ''}">
      <span class="rank">${i + 1}</span>
      <span class="lname">${esc(r.username)}</span>
      <span class="lpnl ${k}">${signed(r.pnl)}</span></li>`;
  }).join('');
}

// --- boot ---
(async function () {
  if (me) refreshMe();
  await loadMarkets();
  loadMatchups();
  await loadFeed();
  await loadLeaderboard();
  connectFeed();
})();
