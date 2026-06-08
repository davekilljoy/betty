# Betty — a Sleeper-backed play-money book for your league

A website your whole league can see. Sleeper is the oddsmaker; the **public bet feed is
the product**. Everyone bets play money against real odds derived from Sleeper's
projections, everyone sees everyone else's bets, and a season-long leaderboard is the
real stakes.

No real money. No auth to speak of (pick a username, who cares). One small Node app +
SQLite, deployed on Fly with a persistent volume.

---

## The core loop

1. A **poller** pulls Sleeper projections each day and turns each player/week into a
   **market** with a *ladder* of bettable lines (rungs) at real odds.
2. Players log in by username and place **bets** — single legs or **parlays** — staking
   from a **weekly bankroll**.
3. Each bet **freezes the line and odds it took**. The line moving afterward is
   irrelevant — you own the price you got.
4. After games go final, a **settlement job** pulls Sleeper actuals, grades every leg,
   pays out, and posts results to the feed.
5. A **season P&L leaderboard** ranks the league. That ranking is the stakes.

---

## Why this is fun (the three things even-money got wrong)

### 1. Real odds, not a coin flip — the **odds ladder**
A projection of `14.5` is a *mean*, not a line. Wrap a distribution around it and one
player becomes a spectrum from chalk to lottery ticket:

```
Christian McCaffrey — proj 14.5 PPR
  OVER 12.5   -250   (~71%)   safe
  OVER 14.5   -110   (~52%)   the coin flip
  OVER 18.5   +180   (~36%)
  OVER 22.5   +450   (~18%)   spicy
  OVER 28.5  +1100   (~8%)    lottery
```

Math: model fantasy points as **lognormal** with mean = projection and a
position-specific coefficient of variation (RBs tighter, WR/TE fatter tails). Then for a
threshold `t`, `P(X > t)` comes straight off the lognormal CDF, and
`payout_decimal = (1 / p) * (1 - HOUSE_EDGE)`. See `src/odds.js`.

### 2. Real edge — the **frozen naive line**
Sleeper's projection is naive and stale: it doesn't know about the beat-writer tweet 20
minutes ago, the weather, or that the starter just got ruled out. You do — that's what a
fantasy league *is*. We freeze the naive line at bet time, so the sharp who bets the
backup RB's volume bump *before* Sleeper catches up gets paid. Edge = fantasy IQ vs a
static number.

### 3. Real stakes — **scarce bankroll that doesn't stack + leaderboard**
- **Offseason / preseason:** one lump grant of `$1,000` (period `0`), issued once. It
  covers the whole pre-regular-season window — it does *not* refresh, and preseason games
  don't count.
- **Regular season:** a fresh `$1,000` at the start of each week (periods `1..18`).
  It **does not stack** — unspent allowance is wiped at week rollover; you never carry a
  balance week-to-week. Blow it Thursday, you spectate till next week.
- **Spendable balance** is therefore scoped to the *current period only*:
  `SUM(ledger.delta WHERE week = currentPeriod)`. Mid-week winnings add to that period's
  balance (you can re-bet them that week) but are wiped at rollover.
- **Season P&L** (the leaderboard) is the persistent score — net betting result across
  every period, *excluding* grants: `SUM(ledger.delta WHERE reason <> 'grant')`.

### The multiplier — **parlays**
Combine N legs; combined odds = product of leg decimals; the bet wins only if **every**
leg wins. A 5-leg longshot hitting for `+6000` is the post everyone screenshots. Parlays
are first-class in P1 because they're 80% of the dopamine.

---

## Data model (see `src/schema.sql`)

- **users** — `username` (PK), `created_ts`.
- **ledger** — append-only money movements (`grant`, `stake`, `payout`, `refund`), each
  tagged with the period (`week`: `0` = preseason lump, `1..18` = season weeks). Spendable
  balance = `SUM(delta WHERE week = currentPeriod)`; season P&L = `SUM(delta WHERE reason
  <> 'grant')`. Exactly one `grant` row per `(user, period)`.
- **markets** — one per `(player, week, stat)`. Holds the Sleeper `projection`, the
  player's `position`, `kickoff_ts` (trading freeze), `settle_after`, and `status`.
- **rungs** — the ladder. Each row is one bettable line: `(market_id, side, threshold,
  odds, implied_prob)`. `side` ∈ {`OVER`,`UNDER`}.
- **bets** — `(username, week, type, stake, combined_odds, status, payout, …)`.
  `type` ∈ {`single`,`parlay`}.
- **bet_legs** — `(bet_id, market_id, rung snapshot…, status, actual_value)`. A single
  bet has one leg; a parlay has many.

### Closed enums (validated at write time)
- `market.stat`: `ppr_pts` (P1 ships this one; `pass_yds`, `rush_yds`, `rec`… later).
- `market.status`: `OPEN` → `FROZEN` (kickoff) → `SETTLING` → `SETTLED` | `VOID`.
- `rung.side`: `OVER` | `UNDER`.
- `bet.type`: `single` | `parlay`.
- `bet.status` / `leg.status`: `OPEN` → `WON` | `LOST` | `VOID`.

---

## The bet contract (invariants)

1. A bet may only be placed while every referenced market is `OPEN` and `now < kickoff_ts`.
2. The leg snapshots `threshold`, `side`, `odds`, and `line` (the projection at that
   moment). These are immutable once written.
3. Stake is validated against the user's current balance **before** the bet commits;
   the whole placement is one transaction.
4. A player who doesn't play (inactive/bye → `actual_value` null at settle) grades the
   leg `VOID`, not `LOST`. A `VOID` leg in a single refunds the stake; in a parlay it
   drops out and the combined odds recompute over the surviving legs.
5. Markets settle only after `settle_after`; a settled market is immutable.

---

## Build phases

- **P1 (this):** schema, Sleeper poller (+ offseason seed fallback), odds ladder,
  weekly bankroll, place single/parlay bets, settlement job, public feed (SSE),
  leaderboard, the board UI.
- **P2:** matchup/league-context markets (rosters, H2H, weekly high score), fade/tail
  one-tap off the feed, dispute hold + manual override.
- **P3:** auto-generate the week's markets from league rosters, richer stats
  (`pass_yds`/`rush_yds`/`rec`), mobile polish.
- **P4:** "suggested bets," market-maker tuning, achievements/badges in the feed.
