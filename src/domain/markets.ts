import type { DB } from '../db.ts';
import { type Bet, computePayouts } from './payout.ts';
import { credit, debit } from './points.ts';
import {
  ATTESTATIONS,
  MAX_CLOSE_DELAY,
  MIN_CLOSE_DELAY,
  type Outcome,
  type Side,
  cleanText,
  rule,
} from './rules.ts';
import { newPublicId } from '../ids.ts';
import { isTimeZone } from '../time.ts';
import { getUser } from './users.ts';

export type MarketStatus = 'pending' | 'open' | 'closed' | 'proposed' | 'disputed' | 'resolved';

export interface Market {
  id: number;
  public_id: string;
  old_number: number | null;
  creator_id: number;
  question: string;
  criteria: string;
  evidence_source: string;
  close_at: number;
  timezone: string | null;
  subject_id: number | null;
  subject_opted_in_at: number | null;
  status: MarketStatus;
  outcome: Outcome | null;
  resolution_note: string | null;
  resolved_at: number | null;
  attestation: string;
  attested_at: number;
  created_at: number;
  deleted_at: number | null;
  deleted_by: number | null;
}

export interface MarketInput {
  question: string;
  criteria: string;
  evidenceSource: string;
  closeAt: number;
  /** IANA zone the close time was typed in, and that the market shows its times in. */
  timeZone: string;
  subjectId: number | null;
  attestations: string[];
}

export function requireActive(db: DB, userId: number): void {
  rule(getUser(db, userId)?.is_active, 'Your account is not active.');
}

/** The market's internal id, from the id in its URL, or NaN. */
export function marketIdFromUrl(db: DB, urlId: string): number {
  const row = db.prepare('SELECT id FROM markets WHERE public_id = ?').get(urlId) as { id: number } | undefined;
  return row?.id ?? NaN;
}

/** The public id for a link that still uses a market's old number, if there is such a market. */
export function publicIdForOldNumber(db: DB, n: number): string | undefined {
  return (db.prepare('SELECT public_id FROM markets WHERE old_number = ?').get(n) as { public_id: string } | undefined)?.public_id;
}

export function getMarket(db: DB, id: number): Market {
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(id) as Market | undefined;
  rule(m, 'No such market.');
  return m;
}

export function createMarket(db: DB, creatorId: number, input: MarketInput, now: number): number {
  requireActive(db, creatorId);
  const question = cleanText(input.question, 'Question', 10, 200);
  const criteria = cleanText(input.criteria, 'Resolution criteria', 10, 1000);
  const evidence = cleanText(input.evidenceSource, 'Evidence source', 3, 300);
  rule(isTimeZone(input.timeZone), 'Pick a time zone.');
  rule(Number.isFinite(input.closeAt), 'Pick a trading close time.');
  rule(input.closeAt >= now + MIN_CLOSE_DELAY, 'Trading must stay open for at least an hour.');
  rule(input.closeAt <= now + MAX_CLOSE_DELAY, 'Trading must close within a year.');
  for (const a of ATTESTATIONS) {
    rule(input.attestations.includes(a.key), 'Tick every item on the checklist. Markets about those topics are not allowed.');
  }

  let status: MarketStatus = 'open';
  let optedInAt: number | null = null;
  if (input.subjectId !== null) {
    const subject = getUser(db, input.subjectId);
    rule(subject?.is_active, 'The subject must be an active member.');
    // Naming yourself counts as opting in; anyone else has to agree first.
    if (subject.id === creatorId) optedInAt = now;
    else status = 'pending';
  }

  const attestation = JSON.stringify(ATTESTATIONS.map((a) => a.text));
  const res = db
    .prepare(
      `INSERT INTO markets (public_id, creator_id, question, criteria, evidence_source, close_at, timezone, subject_id,
         subject_opted_in_at, status, attestation, attested_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newPublicId(), creatorId, question, criteria, evidence, input.closeAt, input.timeZone, input.subjectId, optedInAt, status, attestation, now, now);
  return Number(res.lastInsertRowid);
}

/** The named subject accepts (market opens) or declines (market is voided; nobody could bet yet). */
export function respondAsSubject(db: DB, marketId: number, userId: number, accept: boolean, now: number): void {
  const m = getMarket(db, marketId);
  rule(m.subject_id === userId, 'Only the subject of this market can answer that.');
  rule(m.status === 'pending' && now < m.close_at, 'This market is no longer waiting for you.');
  if (accept) {
    db.prepare("UPDATE markets SET status = 'open', subject_opted_in_at = ? WHERE id = ? AND status = 'pending'").run(
      now,
      marketId,
    );
  } else {
    finalizeMarket(db, marketId, 'VOID', 'The subject declined to take part.', now);
  }
}

export function placeBet(db: DB, marketId: number, userId: number, side: Side, amount: number, now: number): void {
  requireActive(db, userId);
  const m = getMarket(db, marketId);
  rule(m.subject_id !== userId, 'You are the subject of this market, so you cannot bet on it.');
  rule(m.status !== 'pending', 'This market is waiting for its subject to opt in.');
  rule(m.status === 'open' && now < m.close_at, 'Trading on this market has closed.');
  rule(Number.isInteger(amount) && amount >= 1, 'Bet a whole number of points, at least 1.');
  debit(db, userId, 'stake', amount, marketId, now);
  db.prepare('INSERT INTO bets (market_id, user_id, side, amount, created_at) VALUES (?, ?, ?, ?, ?)').run(
    marketId,
    userId,
    side,
    amount,
    now,
  );
}

export function betsFor(db: DB, marketId: number): Bet[] {
  return db
    .prepare('SELECT user_id AS userId, side, amount, created_at AS createdAt FROM bets WHERE market_id = ? ORDER BY id')
    .all(marketId) as Bet[];
}

export function pools(db: DB, marketId: number): { yes: number; no: number; total: number } {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(CASE side WHEN 'YES' THEN amount END), 0) AS yes,
              COALESCE(SUM(CASE side WHEN 'NO' THEN amount END), 0) AS no
       FROM bets WHERE market_id = ?`,
    )
    .get(marketId) as { yes: number; no: number };
  return { ...r, total: r.yes + r.no };
}

/** Records the final outcome and pays out stakes. Idempotent: a resolved market is left alone. */
export function finalizeMarket(db: DB, marketId: number, outcome: Outcome, note: string, now: number): void {
  const bets = betsFor(db, marketId);
  if (outcome !== 'VOID' && bets.length > 0 && !bets.some((b) => b.side === outcome)) {
    note += ' Nobody backed that side, so every stake was refunded.';
  }
  const res = db
    .prepare(
      `UPDATE markets SET status = 'resolved', outcome = ?, resolution_note = ?, resolved_at = ?
       WHERE id = ? AND status <> 'resolved'`,
    )
    .run(outcome, note, now, marketId);
  if (res.changes !== 1) return;
  for (const p of computePayouts(bets, outcome)) credit(db, p.userId, p.type, p.amount, marketId, now);
}

export interface MarketListRow extends Market {
  creator_name: string;
  subject_name: string | null;
  yes_pool: number;
  no_pool: number;
}

const LIST_GROUPS = {
  open: { statuses: ['pending', 'open'], order: 'm.close_at ASC' },
  awaiting: { statuses: ['closed', 'proposed', 'disputed'], order: 'm.close_at ASC' },
  resolved: { statuses: ['resolved'], order: 'm.resolved_at DESC' },
} as const;
export type MarketGroup = keyof typeof LIST_GROUPS;

const LIST_SELECT = `
  SELECT m.*, c.display_name AS creator_name, s.display_name AS subject_name,
    (SELECT COALESCE(SUM(amount), 0) FROM bets WHERE market_id = m.id AND side = 'YES') AS yes_pool,
    (SELECT COALESCE(SUM(amount), 0) FROM bets WHERE market_id = m.id AND side = 'NO') AS no_pool
  FROM markets m JOIN users c ON c.id = m.creator_id LEFT JOIN users s ON s.id = m.subject_id`;

export function listMarkets(db: DB, group: MarketGroup): MarketListRow[] {
  const g = LIST_GROUPS[group];
  const marks = g.statuses.map(() => '?').join(', ');
  return db
    .prepare(`${LIST_SELECT} WHERE m.status IN (${marks}) AND m.deleted_at IS NULL ORDER BY ${g.order} LIMIT 200`)
    .all(...g.statuses) as MarketListRow[];
}

export function getMarketRow(db: DB, id: number): MarketListRow {
  const m = db.prepare(`${LIST_SELECT} WHERE m.id = ?`).get(id) as MarketListRow | undefined;
  rule(m, 'No such market.');
  return m;
}

export function pendingOptIns(db: DB, userId: number): MarketListRow[] {
  return db
    .prepare(`${LIST_SELECT} WHERE m.status = 'pending' AND m.subject_id = ? ORDER BY m.close_at`)
    .all(userId) as MarketListRow[];
}

export interface Position {
  id: number;
  public_id: string;
  question: string;
  status: MarketStatus;
  outcome: Outcome | null;
  yes: number;
  no: number;
  net: number;
}

export function positionsFor(db: DB, userId: number): Position[] {
  return db
    .prepare(
      `SELECT m.id, m.public_id, m.question, m.status, m.outcome,
              SUM(CASE b.side WHEN 'YES' THEN b.amount ELSE 0 END) AS yes,
              SUM(CASE b.side WHEN 'NO' THEN b.amount ELSE 0 END) AS no,
              (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE user_id = ? AND market_id = m.id) AS net
       FROM bets b JOIN markets m ON m.id = b.market_id
       WHERE b.user_id = ?
       GROUP BY m.id
       ORDER BY m.status = 'resolved', m.close_at DESC`,
    )
    .all(userId, userId) as Position[];
}

export interface BetListRow {
  name: string;
  side: Side;
  amount: number;
  created_at: number;
}

export function betList(db: DB, marketId: number): BetListRow[] {
  return db
    .prepare(
      `SELECT u.display_name AS name, b.side, b.amount, b.created_at
       FROM bets b JOIN users u ON u.id = b.user_id WHERE b.market_id = ? ORDER BY b.id DESC`,
    )
    .all(marketId) as BetListRow[];
}
