# Betty

A Sleeper-backed play-money book for your fantasy league. Sleeper sets the lines; the
public bet feed is the product. See [docs/spec.md](docs/spec.md) for the full design.

## Quickstart

```bash
npm install

# Ingest a week's markets from Sleeper (real projections -> odds ladders).
# It's the offseason, so point at a completed season for live data:
BETTY_SEASON=2025 npm run ingest -- 1        # week 1 markets

# (optional) seed a few demo members + bets so the board isn't empty
BETTY_SEASON=2025 npm run demo -- 1

# Run the site. BETTY_WEEK picks the active betting period.
BETTY_WEEK=1 BETTY_SEASON=2025 npm start      # http://localhost:3000
```

Open the URL, type a username, and bet. The feed and leaderboard update live (SSE).

> Port 3000 busy? `PORT=3008 npm start`.

## How it works

- **Markets** — one per `(player, week)`; each carries an **odds ladder** built from the
  Sleeper projection (lognormal model, see `src/odds.js`). Chalk to lottery, real prices.
- **Bankroll** — `$1,000` lump in the preseason (period `0`), then `$1,000` fresh each
  regular-season week that **does not stack**. Season P&L drives the leaderboard.
- **Bets** — singles or parlays. Each leg snapshots its line + odds at placement; the line
  moving afterward doesn't matter. You own the price you took.
- **Settlement** — a background loop freezes markets at kickoff and grades legs against
  Sleeper actuals after games go final. DNP/inactive grades `VOID` (refund), not a loss.

## Env vars

| var | default | meaning |
|---|---|---|
| `PORT` | `3000` | http port |
| `BETTY_DB` | `./data/betty.db` | SQLite file path |
| `BETTY_WEEK` | `0` | active betting period (`0` = preseason lump, `1..18` = weeks) |
| `BETTY_SEASON` | `2025` | NFL season to pull from Sleeper |
| `BETTY_LEAGUE_ID` | `1312071038443454464` | your Sleeper league |
| `BETTY_GRANT` | `1000` | bankroll per period |
| `BETTY_TICK_MS` | `60000` | freeze/settle loop interval |

## Ops

```bash
npm run ingest -- <week>     # refresh markets + ladders for a week
npm run settle -- <week>     # freeze due markets + grade/pay settled ones
```

## Deploy (Fly)

```bash
fly launch --no-deploy
fly volumes create betty_data --size 1
fly deploy
```

The SQLite file lives on the mounted volume (`/data`), so it survives restarts. One
machine stays warm (`min_machines_running = 1`) to keep the settle loop alive.
