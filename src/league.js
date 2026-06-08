// Sleeper league context. P1 uses it to map usernames to real league members (so the
// board shows your actual leaguemates). Rosters/matchups feed P2 matchup markets.
const LEAGUE_ID = process.env.BETTY_LEAGUE_ID || '1312071038443454464';

async function sleeperJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'betty/0.1' } });
  if (!res.ok) throw new Error(`Sleeper ${res.status} for ${url}`);
  return res.json();
}

// [{ user_id, username, display_name, avatar }]
async function fetchMembers() {
  const users = await sleeperJson(`https://api.sleeper.com/v1/league/${LEAGUE_ID}/users`);
  return (users || []).map((u) => ({
    user_id: u.user_id,
    username: (u.display_name || u.username || u.user_id).toLowerCase(),
    display_name: u.display_name || u.username,
    avatar: u.avatar,
  }));
}

async function fetchLeague() {
  return sleeperJson(`https://api.sleeper.com/v1/league/${LEAGUE_ID}`);
}

module.exports = { LEAGUE_ID, fetchMembers, fetchLeague };
