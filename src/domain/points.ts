import type { DB } from '../db.ts';
import { weekStart } from '../time.ts';
import { ALLOWANCE_CAP, WEEKLY_ALLOWANCE, rule } from './rules.ts';

export type LedgerType = 'allowance' | 'stake' | 'winnings' | 'refund' | 'bond' | 'bond_return' | 'jury_reward' | 'raffle_stake' | 'raffle_win';

export const LEDGER_LABELS: Record<LedgerType, string> = {
  allowance: 'Weekly allowance',
  stake: 'Stake',
  winnings: 'Winnings',
  refund: 'Refund',
  bond: 'Bond posted',
  bond_return: 'Bond returned',
  jury_reward: 'Juror reward',
  raffle_stake: 'Raffle entry',
  raffle_win: 'Raffle win',
};

/** Balances are always derived from the ledger. */
export function balanceOf(db: DB, userId: number): number {
  const row = db.prepare('SELECT COALESCE(SUM(amount), 0) AS b FROM ledger WHERE user_id = ?').get(userId) as { b: number };
  return row.b;
}

function append(db: DB, userId: number, type: LedgerType, amount: number, marketId: number | null, now: number): void {
  db.prepare('INSERT INTO ledger (user_id, type, amount, market_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
    userId,
    type,
    amount,
    marketId,
    now,
  );
}

export function credit(db: DB, userId: number, type: LedgerType, amount: number, marketId: number | null, now: number): void {
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`bad credit amount ${amount}`);
  if (amount > 0) append(db, userId, type, amount, marketId, now);
}

/** Removes points, refusing to go below zero. Call inside a transaction. */
export function debit(db: DB, userId: number, type: 'stake' | 'bond' | 'raffle_stake', amount: number, marketId: number | null, now: number): void {
  rule(Number.isInteger(amount) && amount > 0, 'Amount must be a whole number of points above zero.');
  const balance = balanceOf(db, userId);
  rule(amount <= balance, `Not enough points: you have ${balance}, this needs ${amount}.`);
  append(db, userId, type, -amount, marketId, now);
}

/** Points staked in raffle rounds that haven't been drawn yet. They still count towards the allowance cap. */
function openRaffleStakes(db: DB, userId: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM raffle_entries WHERE user_id = ? AND round NOT IN (SELECT round FROM raffle_draws)')
    .get(userId) as { s: number };
  return row.s;
}

/**
 * Grants this week's allowance to one member if they haven't had it yet:
 * 1,000 points, but never lifting the balance above 5,000.
 */
export function grantWeeklyAllowance(db: DB, userId: number, now: number): number {
  const week = weekStart(now);
  const amount = Math.max(0, Math.min(WEEKLY_ALLOWANCE, ALLOWANCE_CAP - balanceOf(db, userId) - openRaffleStakes(db, userId)));
  const res = db
    .prepare('INSERT OR IGNORE INTO allowances (user_id, week_start, amount, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, week, amount, now);
  if (res.changes === 0) return 0;
  credit(db, userId, 'allowance', amount, null, now);
  return amount;
}

export function grantAllowances(db: DB, now: number): void {
  const due = db
    .prepare('SELECT id FROM users WHERE is_active = 1 AND id NOT IN (SELECT user_id FROM allowances WHERE week_start = ?)')
    .all(weekStart(now)) as { id: number }[];
  for (const u of due) grantWeeklyAllowance(db, u.id, now);
}

export interface LedgerRow {
  id: number;
  type: LedgerType;
  amount: number;
  market_id: number | null;
  market_public_id: string | null;
  question: string | null;
  created_at: number;
  running: number;
}

export function ledgerFor(db: DB, userId: number, limit = 200): LedgerRow[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT l.id, l.type, l.amount, l.market_id, m.public_id AS market_public_id, m.question, l.created_at,
                SUM(l.amount) OVER (ORDER BY l.id) AS running
         FROM ledger l LEFT JOIN markets m ON m.id = l.market_id
         WHERE l.user_id = ?
       ) ORDER BY id DESC LIMIT ?`,
    )
    .all(userId, limit) as LedgerRow[];
}

export interface LeaderRow {
  id: number;
  name: string;
  net: number;
  markets: number;
  balance: number;
}

/** Net points from markets resolved since `since` (allowances excluded). */
export function leaderboard(db: DB, since: number): LeaderRow[] {
  return db
    .prepare(
      `SELECT u.id, u.display_name AS name,
              COALESCE(SUM(l.amount), 0) AS net,
              COUNT(DISTINCT l.market_id) AS markets,
              (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE user_id = u.id) AS balance
       FROM users u
       LEFT JOIN ledger l ON l.user_id = u.id AND l.type <> 'allowance'
         AND l.market_id IN (SELECT id FROM markets WHERE status = 'resolved' AND resolved_at >= ? AND deleted_at IS NULL)
       WHERE u.is_active = 1
       GROUP BY u.id
       ORDER BY net DESC, markets DESC, u.display_name`,
    )
    .all(since) as LeaderRow[];
}

export function netForMarket(db: DB, userId: number, marketId: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE user_id = ? AND market_id = ?')
    .get(userId, marketId) as { n: number };
  return row.n;
}
