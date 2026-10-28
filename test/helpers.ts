import { type DB, openDb } from '../src/db.ts';
import { createMarket } from '../src/domain/markets.ts';
import { balanceOf } from '../src/domain/points.ts';
import { ATTESTATIONS } from '../src/domain/rules.ts';
import { createUser } from '../src/domain/users.ts';
import { DAY } from '../src/time.ts';

/** Monday 2026-10-26 12:00 UTC. */
export const T0 = Date.UTC(2026, 9, 26, 12);

export function addUser(db: DB, name: string, now = T0): number {
  return createUser(db, { name, passwordHash: 'not-a-real-hash', adult: true }, now);
}

/** A fresh in-memory database with `n` members named User1..UserN (ids 1..n). */
export function setup(n: number): { db: DB; ids: number[]; bal: (id: number) => number } {
  const db = openDb(':memory:');
  const ids = Array.from({ length: n }, (_, i) => addUser(db, `User${i + 1}`));
  return { db, ids, bal: (id) => balanceOf(db, id) };
}

export function makeMarket(
  db: DB,
  creatorId: number,
  opts: { subjectId?: number | null; closeAt?: number; now?: number } = {},
): number {
  const now = opts.now ?? T0;
  return createMarket(
    db,
    creatorId,
    {
      question: 'Will the build stay green all week?',
      criteria: 'YES if CI on main is green every day until close.',
      evidenceSource: 'The CI dashboard',
      closeAt: opts.closeAt ?? now + DAY,
      timeZone: 'UTC',
      subjectId: opts.subjectId ?? null,
      attestations: ATTESTATIONS.map((a) => a.key),
    },
    now,
  );
}
