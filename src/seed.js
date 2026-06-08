// Offseason seed: realistic-ish PPR projections so the app is fully demoable with no
// live NFL data. Used only when Sleeper returns nothing (see sleeper.js).
function seedPlayers() {
  return [
    { player_id: 's_mccaffrey', player_name: 'Christian McCaffrey', team: 'SF', position: 'RB', ppr_pts: 21.8 },
    { player_id: 's_jefferson', player_name: 'Justin Jefferson', team: 'MIN', position: 'WR', ppr_pts: 19.4 },
    { player_id: 's_allen', player_name: 'Josh Allen', team: 'BUF', position: 'QB', ppr_pts: 23.9 },
    { player_id: 's_hill', player_name: 'Tyreek Hill', team: 'MIA', position: 'WR', ppr_pts: 18.2 },
    { player_id: 's_kelce', player_name: 'Travis Kelce', team: 'KC', position: 'TE', ppr_pts: 13.6 },
    { player_id: 's_mahomes', player_name: 'Patrick Mahomes', team: 'KC', position: 'QB', ppr_pts: 21.1 },
    { player_id: 's_chase', player_name: "Ja'Marr Chase", team: 'CIN', position: 'WR', ppr_pts: 17.9 },
    { player_id: 's_henry', player_name: 'Derrick Henry', team: 'BAL', position: 'RB', ppr_pts: 16.7 },
    { player_id: 's_lamb', player_name: 'CeeDee Lamb', team: 'DAL', position: 'WR', ppr_pts: 17.1 },
    { player_id: 's_pickens', player_name: 'George Pickens', team: 'PIT', position: 'WR', ppr_pts: 11.3 },
    { player_id: 's_andrews', player_name: 'Mark Andrews', team: 'BAL', position: 'TE', ppr_pts: 10.2 },
    { player_id: 's_robinson', player_name: 'Bijan Robinson', team: 'ATL', position: 'RB', ppr_pts: 16.0 },
    { player_id: 's_hall', player_name: 'Breece Hall', team: 'NYJ', position: 'RB', ppr_pts: 15.2 },
    { player_id: 's_nabers', player_name: 'Malik Nabers', team: 'NYG', position: 'WR', ppr_pts: 14.8 },
    { player_id: 's_lamar', player_name: 'Lamar Jackson', team: 'BAL', position: 'QB', ppr_pts: 24.5 },
  ];
}
module.exports = { seedPlayers };
