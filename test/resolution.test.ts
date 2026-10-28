import { describe, expect, it } from 'vitest';
import { getMarket, listMarkets, placeBet, respondAsSubject } from '../src/domain/markets.ts';
import { leaderboard } from '../src/domain/points.ts';
import {
  type Rng,
  bondFor,
  castVote,
  deleteMarket,
  deleteRefusal,
  dispute,
  eligibleJurors,
  getDispute,
  getJurors,
  juryDuty,
  jurySize,
  propose,
  tally,
} from '../src/domain/resolution.ts';
import { tick } from '../src/domain/tick.ts';
import { DAY, HOUR } from '../src/time.ts';
import { T0, addUser, makeMarket, setup } from './helpers.ts';

const CLOSE = T0 + DAY;
const inOrder: Rng = () => 0; // the draw then takes eligible members in id order

/**
 * Eight members. User1 bets YES 100, User2 bets NO 100 (pool 200, bond 50).
 * Trading has closed; nothing proposed yet.
 */
function closedMarket() {
  const s = setup(8);
  const m = makeMarket(s.db, s.ids[0], { closeAt: CLOSE });
  placeBet(s.db, m, 1, 'YES', 100, T0);
  placeBet(s.db, m, 2, 'NO', 100, T0 + 1);
  tick(s.db, CLOSE);
  return { ...s, m };
}

/** As above, plus User3 proposes YES and User4 disputes. Jurors: User5, User6, User7. */
function disputedMarket() {
  const s = closedMarket();
  propose(s.db, s.m, 3, 'YES', 'Saw it happen.', CLOSE + HOUR);
  dispute(s.db, s.m, 4, 'It did not happen.', CLOSE + 2 * HOUR, inOrder);
  return s;
}

describe('bonds', () => {
  it('are 10% of the pool with a 50-point minimum', () => {
    expect(bondFor(0)).toBe(50);
    expect(bondFor(499)).toBe(50);
    expect(bondFor(1234)).toBe(124);
  });
});

describe('VOID', () => {
  it('refunds every stake', () => {
    const { db, m, bal } = closedMarket();
    propose(db, m, 3, 'VOID', 'The event was cancelled.', CLOSE + HOUR);
    tick(db, CLOSE + HOUR + DAY);
    expect(getMarket(db, m)).toMatchObject({ status: 'resolved', outcome: 'VOID' });
    for (const id of [1, 2, 3]) expect(bal(id)).toBe(1000);
  });
});

describe('undisputed proposals', () => {
  it('stand after 24 hours: winners are paid and the bond comes back', () => {
    const { db, m, bal } = closedMarket();
    propose(db, m, 3, 'YES', 'Photo in the group chat.', CLOSE + HOUR);
    expect(bal(3)).toBe(950);
    tick(db, CLOSE + HOUR + DAY - 1);
    expect(getMarket(db, m).status).toBe('proposed');
    tick(db, CLOSE + HOUR + DAY);
    expect(getMarket(db, m)).toMatchObject({ status: 'resolved', outcome: 'YES' });
    expect([bal(1), bal(2), bal(3)]).toEqual([1100, 900, 1000]);
    tick(db, CLOSE + 2 * DAY); // idempotent
    expect([bal(1), bal(2), bal(3)]).toEqual([1100, 900, 1000]);
  });

  it('cannot be made before close or twice', () => {
    const s = setup(2);
    const m = makeMarket(s.db, 1, { closeAt: CLOSE });
    expect(() => propose(s.db, m, 2, 'YES', 'Too early', T0)).toThrow(/not closed/);
    tick(s.db, CLOSE);
    propose(s.db, m, 2, 'YES', 'Saw it.', CLOSE);
    expect(() => propose(s.db, m, 1, 'NO', 'No way', CLOSE)).toThrow(/already been proposed/);
  });
});

describe('disputes and bond forfeiture', () => {
  it('jury upholds the proposal: disputer forfeits to the majority jurors', () => {
    const { db, m, bal } = disputedMarket();
    expect(bal(4)).toBe(950);
    castVote(db, m, 5, 'YES', CLOSE + 3 * HOUR);
    castVote(db, m, 6, 'YES', CLOSE + 4 * HOUR);
    castVote(db, m, 7, 'NO', CLOSE + 5 * HOUR); // last juror: voting closes early
    expect(getMarket(db, m)).toMatchObject({ status: 'resolved', outcome: 'YES' });
    expect(getDispute(db, m)?.jury_outcome).toBe('YES');
    expect([bal(1), bal(2)]).toEqual([1100, 900]); // stakes paid on YES
    expect(bal(3)).toBe(1000); // proposer's bond back
    expect(bal(4)).toBe(950); // disputer's bond lost
    expect([bal(5), bal(6), bal(7)]).toEqual([1025, 1025, 1000]); // majority split 50
  });

  it('jury overturns the proposal: proposer forfeits, rounding down with leftover by vote order', () => {
    const { db, m, bal } = disputedMarket();
    castVote(db, m, 6, 'NO', CLOSE + 3 * HOUR);
    castVote(db, m, 7, 'NO', CLOSE + 4 * HOUR);
    castVote(db, m, 5, 'NO', CLOSE + 5 * HOUR);
    expect(getMarket(db, m).outcome).toBe('NO');
    expect([bal(1), bal(2)]).toEqual([900, 1100]);
    expect(bal(3)).toBe(950);
    expect(bal(4)).toBe(1000);
    expect([bal(6), bal(7), bal(5)]).toEqual([1017, 1017, 1016]);
  });

  it('jury picks VOID over a YES proposal: proposer forfeits and stakes are refunded', () => {
    const { db, m, bal } = disputedMarket();
    castVote(db, m, 5, 'VOID', CLOSE + 3 * HOUR);
    castVote(db, m, 6, 'VOID', CLOSE + 3 * HOUR);
    castVote(db, m, 7, 'YES', CLOSE + 3 * HOUR);
    expect(getMarket(db, m).outcome).toBe('VOID');
    expect([bal(1), bal(2), bal(3), bal(4)]).toEqual([1000, 1000, 950, 1000]);
  });

  it('cannot dispute your own proposal, after 24 hours, or a second time', () => {
    const { db, m } = closedMarket();
    propose(db, m, 3, 'YES', 'Saw it happen.', CLOSE);
    expect(() => dispute(db, m, 3, 'Changed my mind', CLOSE + HOUR, inOrder)).toThrow(/own proposal/);
    expect(() => dispute(db, m, 4, 'Too slow', CLOSE + DAY, inOrder)).toThrow(/challenge window/);
    dispute(db, m, 4, 'Wrong outcome', CLOSE + HOUR, inOrder);
    expect(() => dispute(db, m, 5, 'Me too', CLOSE + HOUR, inOrder)).toThrow(/no open proposal/);
  });

  it('allows at most 3 disputes per member per week', () => {
    const s = setup(10);
    const markets = [1, 2, 3, 4].map(() => makeMarket(s.db, 1, { closeAt: CLOSE }));
    tick(s.db, CLOSE);
    for (const m of markets) propose(s.db, m, 1, 'YES', 'It happened.', CLOSE);
    for (const m of markets.slice(0, 3)) dispute(s.db, m, 2, 'It did not.', CLOSE, inOrder);
    expect(() => dispute(s.db, markets[3], 2, 'It did not.', CLOSE, inOrder)).toThrow(/all 3/);
    dispute(s.db, markets[3], 3, 'It did not.', CLOSE, inOrder); // others are unaffected
  });
});

describe('jurors', () => {
  it('have no stake and are not the subject, proposer or disputer', () => {
    const s = setup(9);
    const m = makeMarket(s.db, 1, { subjectId: 8, closeAt: CLOSE });
    respondAsSubject(s.db, m, 8, true, T0);
    placeBet(s.db, m, 1, 'YES', 10, T0);
    placeBet(s.db, m, 2, 'NO', 10, T0);
    s.db.prepare('UPDATE users SET is_active = 0 WHERE id = 9').run();
    tick(s.db, CLOSE);
    propose(s.db, m, 3, 'YES', 'It happened.', CLOSE);
    expect(eligibleJurors(s.db, m)).toEqual([4, 5, 6, 7]);
    dispute(s.db, m, 4, 'It did not.', CLOSE, () => 0);
    expect(eligibleJurors(s.db, m)).toEqual([5, 6, 7]);
    expect(getJurors(s.db, m).map((j) => j.user_id)).toEqual([5, 6, 7]);
  });

  it('are drawn at random from the eligible members', () => {
    const { db, m } = closedMarket();
    propose(db, m, 3, 'YES', 'Saw it happen.', CLOSE);
    const last: Rng = (max) => max - 1; // always swap in the last candidate
    dispute(db, m, 4, 'It did not.', CLOSE, last);
    expect(getJurors(db, m).map((j) => j.user_id).sort()).toEqual([5, 6, 8]);
  });

  it('number 3 below 12 members and 5 from 12', () => {
    const s = setup(11);
    expect(jurySize(s.db)).toBe(3);
    addUser(s.db, 'Twelfth');
    expect(jurySize(s.db)).toBe(5);
  });

  it('are the only ones who can vote, once, and votes stay hidden until close', () => {
    const { db, m } = disputedMarket();
    expect(() => castVote(db, m, 1, 'YES', CLOSE + 3 * HOUR)).toThrow(/not on this jury/);
    castVote(db, m, 5, 'YES', CLOSE + 3 * HOUR);
    expect(() => castVote(db, m, 5, 'NO', CLOSE + 3 * HOUR)).toThrow(/already voted/);
    expect(getDispute(db, m)?.closed_at).toBeNull();
    expect(getMarket(db, m).status).toBe('disputed');
  });

  it('void the market at once, returning both bonds, when fewer than 3 are eligible', () => {
    const s = setup(5);
    const m = makeMarket(s.db, 1, { closeAt: CLOSE });
    placeBet(s.db, m, 1, 'YES', 100, T0);
    placeBet(s.db, m, 2, 'NO', 100, T0);
    tick(s.db, CLOSE);
    propose(s.db, m, 3, 'YES', 'It happened.', CLOSE);
    dispute(s.db, m, 4, 'It did not.', CLOSE, inOrder); // only User5 is left to serve
    expect(getMarket(s.db, m)).toMatchObject({ status: 'resolved', outcome: 'VOID' });
    for (const id of s.ids) expect(s.bal(id)).toBe(1000);
  });
});

describe('tally', () => {
  it('needs a quorum of 3 and a 2/3 supermajority of votes cast', () => {
    expect(tally(['YES', 'YES'])).toBeNull();
    expect(tally(['YES', 'YES', 'NO'])).toBe('YES');
    expect(tally(['YES', 'NO', 'VOID'])).toBeNull();
    expect(tally(['NO', 'NO', 'NO', 'YES', 'YES'])).toBeNull(); // 3/5 is short of 2/3
    expect(tally(['NO', 'NO', 'NO', 'NO', 'YES'])).toBe('NO');
    expect(tally(['VOID', 'VOID', 'YES', 'VOID'])).toBe('VOID');
  });
});

describe('deadline auto-void', () => {
  it('voids a market with no proposal 7 days after close', () => {
    const { db, m, bal } = closedMarket();
    tick(db, CLOSE + 7 * DAY - 1); // also crosses a Monday, so the allowance lands here
    expect(getMarket(db, m).status).toBe('closed');
    const before = [bal(1), bal(2)];
    tick(db, CLOSE + 7 * DAY);
    expect(getMarket(db, m)).toMatchObject({ status: 'resolved', outcome: 'VOID' });
    expect([bal(1), bal(2)]).toEqual([before[0] + 100, before[1] + 100]);
    expect(() => propose(db, m, 3, 'YES', 'Too late', CLOSE + 7 * DAY)).toThrow(/already resolved/);
  });

  it('voids a disputed market when the jury has not decided after 72 hours', () => {
    const { db, m, bal } = disputedMarket();
    const disputedAt = CLOSE + 2 * HOUR;
    castVote(db, m, 5, 'YES', disputedAt + HOUR);
    castVote(db, m, 6, 'NO', disputedAt + HOUR);
    tick(db, disputedAt + 72 * HOUR - 1);
    expect(getMarket(db, m).status).toBe('disputed');
    tick(db, disputedAt + 72 * HOUR);
    expect(getMarket(db, m)).toMatchObject({ status: 'resolved', outcome: 'VOID' });
    expect(() => castVote(db, m, 7, 'YES', disputedAt + 72 * HOUR)).toThrow(/not open/);
    for (const id of [1, 2, 3, 4, 5, 6, 7]) expect(bal(id)).toBe(1000); // stakes and both bonds back
  });

  it('closes the betting window and then voids a market whose server slept through every deadline', () => {
    const s = setup(2);
    const m = makeMarket(s.db, 1, { closeAt: CLOSE });
    placeBet(s.db, m, 2, 'YES', 300, T0);
    tick(s.db, CLOSE + 30 * DAY);
    expect(getMarket(s.db, m)).toMatchObject({ status: 'resolved', outcome: 'VOID' });
    expect(s.bal(2)).toBeGreaterThanOrEqual(1000);
  });
});

describe('deleting markets', () => {
  it('lets the creator delete their own market until someone else bets', () => {
    const s = setup(3);
    const m = makeMarket(s.db, 1, { closeAt: CLOSE });
    placeBet(s.db, m, 1, 'YES', 50, T0);
    expect(deleteRefusal(s.db, m, 2)).toMatch(/creator or an admin/);
    expect(deleteRefusal(s.db, m, 1)).toBeNull();
    placeBet(s.db, m, 2, 'NO', 30, T0);
    expect(() => deleteMarket(s.db, m, 1, T0)).toThrow(/only an admin/);
  });

  it('lets the admin delete any unresolved market, returning every stake and bond', () => {
    const s = setup(8);
    s.db.prepare('UPDATE users SET is_admin = 1 WHERE id = 8').run();
    const m = makeMarket(s.db, 1, { closeAt: CLOSE });
    placeBet(s.db, m, 2, 'YES', 100, T0);
    placeBet(s.db, m, 3, 'NO', 200, T0);
    tick(s.db, CLOSE);
    propose(s.db, m, 4, 'YES', 'It happened.', CLOSE);
    dispute(s.db, m, 5, 'It did not.', CLOSE, () => 0);
    expect(getMarket(s.db, m).status).toBe('disputed');

    deleteMarket(s.db, m, 8, CLOSE + 1);
    expect(getMarket(s.db, m)).toMatchObject({ status: 'resolved', outcome: 'VOID', deleted_by: 8 });
    for (const id of [2, 3, 4, 5]) expect(s.bal(id)).toBe(1000);
    expect(juryDuty(s.db, 6)).toEqual([]);
    expect(listMarkets(s.db, 'resolved').map((x) => x.id)).not.toContain(m);
    expect(leaderboard(s.db, 0).find((r) => r.id === 2)!.markets).toBe(0);
  });

  it("won't delete a resolved market", () => {
    const s = setup(3);
    s.db.prepare('UPDATE users SET is_admin = 1 WHERE id = 3').run();
    const m = makeMarket(s.db, 1, { closeAt: CLOSE });
    tick(s.db, CLOSE + 8 * DAY); // voided for want of a proposal
    expect(() => deleteMarket(s.db, m, 3, CLOSE + 8 * DAY)).toThrow(/resolved/);
  });
});
