# Betty — Design System

## Theme & scene
Scene: a league manager glancing at the board on their phone on a Thursday evening, and
again sprawled on the couch Sunday afternoon as games resolve and the feed lights up.
Evening use, competitive mood, odds-scanning. **Dark** — but warm and characterful, not
the cold neon-green sportsbook reflex. A late-night bookie's backroom, not a casino floor.

## Color — Full palette (semantic roles)
A betting board is colorful by function: side, result, and price all carry meaning. Each
color is a committed role, not decoration. OKLCH, neutrals tinted warm-violet (never #000/#fff).

- **Base ink**: `oklch(0.17 0.012 300)` page; surfaces step up `0.20` / `0.235`.
- **Brand / primary (gold)**: `oklch(0.82 0.15 85)` — the "betty." mark, primary actions,
  bankroll. Retro-bookie neon-sign gold, deliberately not betting-green.
- **Over (cool sky)**: `oklch(0.74 0.13 235)`.
- **Under (warm magenta)**: `oklch(0.72 0.16 350)`.
- **Win (mint)**: `oklch(0.80 0.16 158)`.
- **Loss (coral)**: `oklch(0.66 0.19 22)`.
- **Text**: `oklch(0.95 0.008 300)` primary, `oklch(0.68 0.015 300)` dim.
- Line/border: `oklch(0.30 0.015 300)`.

## Typography
- **Display / brand / headers**: "Bricolage Grotesque" (700–800). Characterful grotesque,
  carries personality without costume.
- **Body / UI**: "Inter".
- **Odds & money**: tabular figures (`font-variant-numeric: tabular-nums`) so columns of
  prices align. Numbers are first-class here; never let them reflow.
- Scale ratio ≥1.25. Brand mark large and tight-tracked; section labels small, uppercase,
  wide-tracked, dim.

## Elevation & surface
Subtle. Surfaces separate by tinted background steps + 1px borders, not heavy shadows.
The bet slip is the one genuinely floating element (it overlays the board): soft large-radius
shadow, gold hairline border. No glassmorphism.

## Components
- **Market row**: player avatar (Sleeper headshot) + team logo, name/pos/team, projection,
  and a horizontal odds ladder of rung chips. Over chips read cool, under chips warm.
- **Rung chip**: threshold + American odds, tabular. Hover lifts border to gold; selected
  fills gold-tinted. Generous tap target (phone-first).
- **Filter/sort bar**: sticky, segmented controls for position, a team picker, and sort.
  Quiet until focused.
- **Feed item**: avatar + username + legs + amount. Result state recolors the amount
  (win mint / loss coral / void dim) and adds a small status glyph. New items slide in.
- **Leaderboard**: rank, name, season PnL (mint/coral). The user's own row highlighted.

## Motion
Ease-out-quint for entrances. Feed items slide+fade in (transform/opacity only). Odds-chip
hover is a fast border/See transition. The live dot pulses. No bounce, no layout animation.

## Imagery
- Player avatar: `https://sleepercdn.com/content/nfl/players/thumb/{player_id}.jpg`
  (fallback: position-tinted monogram).
- Team logo: `https://sleepercdn.com/images/team_logos/nfl/{team}.png` (lowercase abbr).
