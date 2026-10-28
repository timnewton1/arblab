import { randomInt } from 'node:crypto';
import type { DB } from '../db.ts';
import { weekStart } from '../time.ts';
import { betsFor, finalizeMarket, getMarket, pools, requireActive } from './markets.ts';
import { splitEvenly } from './payout.ts';
import { credit, debit } from './points.ts';
import {
  CHALLENGE_WINDOW,
  DISPUTES_PER_WEEK,
  JURY_SIZE,
  JURY_WINDOW,
  MIN_BOND,
  OUTCOMES,
  type Outcome,
  PROPOSAL_DEADLINE,
  QUORUM,
  RuleError,
  SMALL_GROUP,
  SMALL_JURY_SIZE,
  cleanText,
  rule,
} from './rules.ts';
import { activeMemberCount, getUser } from './users.ts';

/** Returns a uniformly random integer in [0, max). Injectable so tests are deterministic. */
export type Rng = (max: number) => number;

export interface Proposal {
  market_id: number;
  user_id: number;
  outcome: Outcome;
  note: string;
  bond: number;
  created_at: number;
  challenge_ends_at: number;
}

export interface Dispute {
  market_id: number;
  user_id: number;
  note: string;
  bond: number;
  created_at: number;
  voting_ends_at: number;
  closed_at: number | null;
  jury_outcome: Outcome | null;
}

export interface Juror {
  user_id: number;
  vote: Outcome | null;
  voted_at: number | null;
}

/** 10% of the total pool, rounded up, never less than 50. Disputes post the same amount. */
export function bondFor(totalPool: number): number {
  return Math.max(MIN_BOND, Math.ceil(totalPool / 10));
}

export function getProposal(db: DB, marketId: number): Proposal | undefined {
  return db.prepare('SELECT * FROM proposals WHERE market_id = ?').get(marketId) as Proposal | undefined;
}

export function getDispute(db: DB, marketId: number): Dispute | undefined {
  return db.prepare('SELECT * FROM disputes WHERE market_id = ?').get(marketId) as Dispute | undefined;
}

export function getJurors(db: DB, marketId: number): Juror[] {
  return db
    .prepare('SELECT user_id, vote, voted_at FROM jurors WHERE market_id = ? ORDER BY voted_at IS NULL, voted_at, user_id')
    .all(marketId) as Juror[];
}

export function propose(db: DB, marketId: number, userId: number, outcome: Outcome, note: string, now: number): void {
  requireActive(db, userId);
  const m = getMarket(db, marketId);
  rule(m.status !== 'pending' && m.status !== 'open', 'Trading has not closed yet.');
  rule(m.status !== 'resolved', 'This market is already resolved.');
  rule(m.status === 'closed', 'An outcome has already been proposed for this market.');
  rule(now < m.close_at + PROPOSAL_DEADLINE, 'The 7-day window for proposals has passed.');
  const text = cleanText(note, 'Evidence note', 5, 1000);
  const bond = bondFor(pools(db, marketId).total);
  debit(db, userId, 'bond', bond, marketId, now);
  db.prepare(
    `INSERT INTO proposals (market_id, user_id, outcome, note, bond, created_at, challenge_ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(marketId, userId, outcome, text, bond, now, now + CHALLENGE_WINDOW);
  db.prepare("UPDATE markets SET status = 'proposed' WHERE id = ?").run(marketId);
}

export function disputesThisWeek(db: DB, userId: number, now: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM disputes WHERE user_id = ? AND created_at >= ?').get(userId, weekStart(now)) as {
      n: number;
    }
  ).n;
}

/** Active members with no bet in the market who are not its subject, proposer or disputer. */
export function eligibleJurors(db: DB, marketId: number): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM users
       WHERE is_active = 1
         AND id NOT IN (SELECT user_id FROM bets WHERE market_id = :m)
         AND id IS NOT (SELECT subject_id FROM markets WHERE id = :m)
         AND id NOT IN (SELECT user_id FROM proposals WHERE market_id = :m)
         AND id NOT IN (SELECT user_id FROM disputes WHERE market_id = :m)
       ORDER BY id`,
    )
    .all({ m: marketId }) as { id: number }[];
  return rows.map((r) => r.id);
}

export function jurySize(db: DB): number {
  return activeMemberCount(db) < SMALL_GROUP ? SMALL_JURY_SIZE : JURY_SIZE;
}

/** Partial Fisher–Yates shuffle: the first `size` picks are uniformly random. */
export function drawJurors(candidates: number[], size: number, rng: Rng): number[] {
  const pool = [...candidates];
  const n = Math.min(size, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + rng(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export function dispute(db: DB, marketId: number, userId: number, note: string, now: number, rng: Rng = randomInt): void {
  requireActive(db, userId);
  const m = getMarket(db, marketId);
  const p = getProposal(db, marketId);
  rule(m.status === 'proposed' && p, 'There is no open proposal to dispute.');
  rule(now < p.challenge_ends_at, 'The 24-hour challenge window has closed.');
  rule(p.user_id !== userId, 'You cannot dispute your own proposal.');
  rule(
    disputesThisWeek(db, userId, now) < DISPUTES_PER_WEEK,
    `You have used all ${DISPUTES_PER_WEEK} of your disputes this week. The count resets on Monday (UTC).`,
  );
  const text = cleanText(note, 'Dispute note', 5, 1000);
  debit(db, userId, 'bond', p.bond, marketId, now);
  db.prepare(
    'INSERT INTO disputes (market_id, user_id, note, bond, created_at, voting_ends_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(marketId, userId, text, p.bond, now, now + JURY_WINDOW);
  db.prepare("UPDATE markets SET status = 'disputed' WHERE id = ?").run(marketId);

  const jurors = drawJurors(eligibleJurors(db, marketId), jurySize(db), rng);
  const insert = db.prepare('INSERT INTO jurors (market_id, user_id, drawn_at) VALUES (?, ?, ?)');
  for (const j of jurors) insert.run(marketId, j, now);
  if (jurors.length < QUORUM) {
    closeVoting(db, marketId, now, `Only ${jurors.length} members had no stake in this market, so no jury of ${QUORUM} could be formed.`);
  }
}

export function castVote(db: DB, marketId: number, userId: number, vote: Outcome, now: number): void {
  requireActive(db, userId);
  const d = getDispute(db, marketId);
  rule(d && d.closed_at === null && now < d.voting_ends_at, 'Jury voting is not open for this market.');
  const juror = db.prepare('SELECT * FROM jurors WHERE market_id = ? AND user_id = ?').get(marketId, userId) as
    | Juror
    | undefined;
  rule(juror, 'You are not on this jury.');
  rule(juror.vote === null, 'You have already voted. Votes are final.');
  db.prepare('UPDATE jurors SET vote = ?, voted_at = ? WHERE market_id = ? AND user_id = ?').run(vote, now, marketId, userId);
  const waiting = db.prepare('SELECT COUNT(*) AS n FROM jurors WHERE market_id = ? AND vote IS NULL').get(marketId) as {
    n: number;
  };
  if (waiting.n === 0) closeVoting(db, marketId, now);
}

/** Needs a quorum of 3 votes and one outcome with at least 2/3 of the votes cast. */
export function tally(votes: Outcome[]): Outcome | null {
  if (votes.length < QUORUM) return null;
  for (const o of OUTCOMES) {
    if (3 * votes.filter((v) => v === o).length >= 2 * votes.length) return o;
  }
  return null;
}

/** Undisputed proposal after 24 hours: the proposer's bond comes back and the outcome stands. */
export function acceptProposal(db: DB, marketId: number, now: number): void {
  const p = getProposal(db, marketId);
  rule(p, 'No proposal.');
  credit(db, p.user_id, 'bond_return', p.bond, marketId, now);
  finalizeMarket(db, marketId, p.outcome, 'The proposed outcome went unchallenged for 24 hours.', now);
}

/**
 * Ends jury voting. With a decision, the side the jury disagreed with forfeits its bond to the
 * majority jurors and the other side gets its bond back. Without one, the market is VOID and
 * both bonds are returned.
 */
export function closeVoting(db: DB, marketId: number, now: number, reason?: string): void {
  const d = getDispute(db, marketId);
  const p = getProposal(db, marketId);
  if (!d || !p || d.closed_at !== null) return;
  const votes = db
    .prepare('SELECT user_id, vote FROM jurors WHERE market_id = ? AND vote IS NOT NULL ORDER BY voted_at, user_id')
    .all(marketId) as { user_id: number; vote: Outcome }[];
  const decided = tally(votes.map((v) => v.vote));
  db.prepare('UPDATE disputes SET closed_at = ?, jury_outcome = ? WHERE market_id = ?').run(now, decided, marketId);

  if (decided === null) {
    credit(db, p.user_id, 'bond_return', p.bond, marketId, now);
    credit(db, d.user_id, 'bond_return', d.bond, marketId, now);
    const why =
      reason ??
      `The jury did not reach a decision (${votes.length} vote${votes.length === 1 ? '' : 's'}; a quorum of ${QUORUM} and a 2/3 majority are needed).`;
    finalizeMarket(db, marketId, 'VOID', `${why} Both bonds were returned.`, now);
    return;
  }

  const proposerWins = decided === p.outcome;
  const [winner, loser] = proposerWins ? [p, d] : [d, p];
  credit(db, winner.user_id, 'bond_return', winner.bond, marketId, now);
  const majority = votes.filter((v) => v.vote === decided).map((v) => v.user_id);
  for (const share of splitEvenly(loser.bond, majority)) credit(db, share.userId, 'jury_reward', share.amount, marketId, now);
  const note = proposerWins
    ? `The jury upheld the proposal (${majority.length} of ${votes.length} votes). The disputer's bond went to the majority jurors.`
    : `The jury overturned the proposal (${majority.length} of ${votes.length} votes). The proposer's bond went to the majority jurors.`;
  finalizeMarket(db, marketId, decided, note, now);
}

/** Open juries this member sits on and hasn't voted in yet. */
export function juryDuty(db: DB, userId: number): { id: number; public_id: string; question: string; voting_ends_at: number }[] {
  return db
    .prepare(
      `SELECT m.id, m.public_id, m.question, d.voting_ends_at
       FROM jurors j JOIN disputes d ON d.market_id = j.market_id JOIN markets m ON m.id = j.market_id
       WHERE j.user_id = ? AND j.vote IS NULL AND d.closed_at IS NULL
       ORDER BY d.voting_ends_at`,
    )
    .all(userId) as { id: number; public_id: string; question: string; voting_ends_at: number }[];
}

/**
 * Why `userId` can't delete the market, or null if they can. An admin can delete any market that isn't
 * resolved; its creator only while nobody else has bet on it and no outcome has been proposed. Resolved
 * markets stay: their points have been paid out.
 */
export function deleteRefusal(db: DB, marketId: number, userId: number): string | null {
  const m = getMarket(db, marketId);
  const user = getUser(db, userId);
  if (!user?.is_active) return 'Your account is not active.';
  if (m.deleted_at !== null) return 'This market has already been deleted.';
  if (m.status === 'resolved') return "A resolved market can't be deleted: its points have been paid out.";
  if (user.is_admin) return null;
  if (m.creator_id !== userId) return 'Only its creator or an admin can delete a market.';
  if (betsFor(db, marketId).some((b) => b.userId !== userId)) return 'Others have bet on this market, so only an admin can delete it now.';
  if (m.status === 'proposed' || m.status === 'disputed') return 'An outcome has been proposed, so only an admin can delete it now.';
  return null;
}

/** Cancels the market for everyone and hides it: every stake and any bond still held goes back. */
export function deleteMarket(db: DB, marketId: number, userId: number, now: number): void {
  const refusal = deleteRefusal(db, marketId, userId);
  if (refusal) throw new RuleError(refusal);
  const m = getMarket(db, marketId);
  const p = getProposal(db, marketId);
  const d = getDispute(db, marketId);
  let bonds = false;
  if (p && (m.status === 'proposed' || m.status === 'disputed')) {
    credit(db, p.user_id, 'bond_return', p.bond, marketId, now);
    bonds = true;
  }
  if (d && d.closed_at === null) {
    db.prepare('UPDATE disputes SET closed_at = ? WHERE market_id = ?').run(now, marketId); // the jury is stood down
    credit(db, d.user_id, 'bond_return', d.bond, marketId, now);
  }
  const name = getUser(db, userId)!.display_name;
  finalizeMarket(db, marketId, 'VOID', `Deleted by ${name}. Every stake${bonds ? ' and bond' : ''} was returned.`, now);
  db.prepare('UPDATE markets SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now, userId, marketId);
}
