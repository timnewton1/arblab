# Plan

A small invite-only prediction market for up to 50 friends. Play points only.

## Shape

- One Node process (Hono + `@hono/node-server`), one SQLite file (better-sqlite3), HTML
  rendered on the server from tagged template literals, one CSS file, one tiny JS file.
- TypeScript runs directly on Node ≥ 22.18 via built-in type stripping, so there is no
  build step at all. `tsc --noEmit` is used only for type checking.
- All rules live in plain functions in `src/domain/` that take `(db, ..., now)`. Routes are thin:
  parse the form, call a domain function inside a transaction, redirect. Tests call the domain
  functions directly with an in-memory database and a fake clock.

## Files

```
src/server.ts          entry: open DB, start HTTP server, 5s tick
src/app.ts             routes + session/CSRF middleware
src/db.ts              schema (CREATE TABLE IF NOT EXISTS) + open helper
src/html.ts            ~20-line escaping `html` tagged template
src/time.ts            week/season boundaries, formatting
src/domain/            points.ts, users.ts, markets.ts, payout.ts, resolution.ts, tick.ts
src/views/             layout + page templates
src/cli.ts             create-admin, reset-password, seed-demo
public/style.css       < 200 lines
public/app.js          time zone pickers + local-time display (the server reads the close time in the market's zone)
test/*.test.ts         vitest
```

## Schema

- `users` (display_name unique, password_hash, is_admin, is_active, adult_confirmed_at, invited_by)
- `invites` (token, created_by, expires_at, used_by, used_at)
- `ledger` (user_id, type, amount, market_id, created_at). Append-only through
  `BEFORE UPDATE` / `BEFORE DELETE` triggers that abort. **Balances are always
  `SUM(amount)`**. No cached balance column, so nothing to reconcile.
- `allowances` (user_id, week_start). One row per member per week makes the Monday grant idempotent.
- `markets` (question, criteria, evidence_source, close_at, subject_id, status, outcome,
  attestation JSON + attested_at, resolved_at, resolution_note)
- `bets` (market_id, user_id, side, amount)
- `proposals` (one per market: outcome, note, bond, challenge_ends_at)
- `disputes` (one per market: note, bond, voting_ends_at)
- `jurors` (market_id, user_id, vote, voted_at)

Ledger types: `allowance`, `stake`, `winnings`, `refund`, `bond`, `bond_return`, `jury_reward`, `raffle_stake`, `raffle_win`.

Raffles: `raffle_entries` (round = the start of a 30-second window, user, amount) and `raffle_draws` (one row per drawn
round). Each point is a ticket and one ticket takes the whole pot. `tick()` draws every finished round
that has entries and no draw row, so a missed round is drawn late rather than lost.

## Market state machine

```
pending ──subject opts in──▶ open ──close_at──▶ closed ──proposal──▶ proposed ──24h, no dispute──▶ resolved
   │                                              │                     │
   └─declined / close passes─▶ resolved(VOID)     └─7 days─▶ VOID        └─dispute─▶ disputed ──jury──▶ resolved
                                                                                        └─72h, no decision─▶ VOID
```

`tick(db, now)` makes every time-based transition (allowance, close, auto-void, auto-resolve,
jury close). It runs at the start of every request and on a 5-second `setInterval` (raffles are drawn on it). Every
transition is guarded by `WHERE status = ?`, so running it twice changes nothing.

## Points

- Allowance: on the first tick of each UTC week (Monday 00:00), each active member gets
  `min(1000, 5000 − balance)` points (never negative). New members get the current week's
  allowance when they join, so nobody starts at zero.
- Debits (stakes, bonds) check the derived balance inside the same transaction.

## Payout math (parimutuel)

For outcome YES/NO, with W = winning pool and L = losing pool, stakes added up per member:
- share_i = floor(L × s_i / W); winner receives s_i + share_i.
- leftover = L − Σ share_i (always < number of winners) → +1 each to winners ordered by stake desc,
  then earliest bet, then user id.
- W = 0 (nobody backed the winning side): everyone is refunded.
- VOID: everyone is refunded.

## Resolution

- Proposal: any active member, after close, within 7 days. Bond = max(50, ceil(10% of pool)).
- Dispute: within 24h of the proposal, by anyone but the proposer, with an equal bond.
  Max 3 disputes per member per UTC week (Monday start).
- Jury: drawn at dispute time with `crypto.randomInt` (injectable for tests). Size 5, or 3 if
  fewer than 12 active members. Eligible means active, no bet in the market, and not the subject,
  proposer or disputer. If fewer than 3 are eligible, quorum can never be met, so the market
  resolves VOID immediately and both bonds are returned (the dispute form warns about this first).
- Votes are YES/NO/VOID, one per juror, final once cast, and hidden until voting closes.
  Voting closes when every juror has voted or 72h pass. Decided if ≥3 votes and one outcome
  has ≥ 2/3 of the votes cast.
- The jury agrees with the proposal → the disputer forfeits. Otherwise → the proposer forfeits. The winner
  gets their bond back; majority jurors split the forfeited bond equally (floor, leftover +1 in
  vote order).
- No decision → VOID, both bonds returned.

## Interpretations worth flagging

- **5,000 cap** limits the allowance top-up; winnings can take a balance above 5,000
  (a hard cap would destroy points out of a pool).
- **50-member cap** counts *active* members, so deactivating someone frees a seat. Checked
  when an invite is created and enforced inside the redemption transaction.
- **Subject** can be the creator (creating it counts as opting in), cannot bet, cannot be a juror,
  may propose an outcome.
- **Season** = calendar quarter (UTC). Leaderboard score = net points from resolved markets
  (stakes, winnings, refunds, bonds, juror rewards; allowance excluded).
- Bets are visible to all members; juror identities are hidden until voting closes.

## Tests

payout rounding/leftover, void refunds, bond forfeiture both ways + juror split, juror
eligibility, subject betting block, auto-void (7d, 72h), allowance cap + idempotency,
50-member cap + single-use invites, dispute weekly limit, ledger append-only, and an HTTP
smoke test that renders every page and greps for banned money words.
