import type { DB } from './db.ts';
import { createMarket, placeBet, respondAsSubject } from './domain/markets.ts';
import { propose } from './domain/resolution.ts';
import { ATTESTATIONS } from './domain/rules.ts';
import { tick } from './domain/tick.ts';
import { createUser } from './domain/users.ts';
import { DAY, HOUR } from './time.ts';

export const DEMO_NAMES = ['Alice', 'Bob', 'Carol', 'Dev', 'Erin', 'Femi'];

/** Six members (Alice is the owner) and three markets: open, open with a subject, and awaiting resolution. */
export function seedDemo(db: DB, now: number, passwordHash: string): void {
  db.transaction(() => {
    const joined = now - 3 * DAY;
    const [alice, bob, carol, dev, erin, femi] = DEMO_NAMES.map((name, i) =>
      createUser(db, { name, passwordHash, isOwner: i === 0, adult: true }, joined),
    );
    const attestations = ATTESTATIONS.map((a) => a.key);

    // Awaiting resolution: trading closed two hours ago and Dev has proposed YES.
    const trip = createMarket(
      db,
      carol,
      {
        question: 'Will the group trip be booked by Friday?',
        criteria: 'YES if accommodation for the trip is booked and the confirmation is shared in the group chat before trading closes.',
        evidenceSource: 'Booking confirmation in the group chat',
        closeAt: now - 2 * HOUR,
        timeZone: 'UTC',
        subjectId: null,
        attestations,
      },
      joined,
    );
    placeBet(db, trip, alice, 'YES', 100, joined + HOUR);
    placeBet(db, trip, bob, 'NO', 80, joined + 2 * HOUR);
    placeBet(db, trip, carol, 'YES', 60, joined + 3 * HOUR);
    placeBet(db, trip, erin, 'NO', 40, joined + 4 * HOUR);

    // Open, about a member who has opted in. Bob cannot bet on it.
    const run = createMarket(
      db,
      alice,
      {
        question: 'Will Bob run the club 10K in under 50 minutes?',
        criteria: "YES if Bob's official chip time in the published results is under 50:00. NO if slower or he doesn't start.",
        evidenceSource: 'Official race results page',
        closeAt: now + 10 * DAY,
        timeZone: 'America/New_York',
        subjectId: bob,
        attestations,
      },
      now - 2 * DAY,
    );

    // Open, no subject.
    const snow = createMarket(
      db,
      dev,
      {
        question: 'Will it snow in Edinburgh before trading closes?',
        criteria: 'YES if Met Office daily observations for Edinburgh record any snowfall between market creation and close.',
        evidenceSource: 'https://www.metoffice.gov.uk/',
        closeAt: now + 20 * DAY,
        timeZone: 'Europe/London',
        subjectId: null,
        attestations,
      },
      now - 2 * DAY,
    );

    respondAsSubject(db, run, bob, true, now - 2 * DAY + HOUR);
    placeBet(db, snow, bob, 'YES', 200, now - 2 * DAY + HOUR);
    placeBet(db, run, alice, 'YES', 100, now - 2 * DAY + 2 * HOUR);
    placeBet(db, run, carol, 'NO', 120, now - DAY);
    placeBet(db, snow, carol, 'NO', 150, now - DAY);
    placeBet(db, snow, dev, 'YES', 50, now - DAY + HOUR);
    placeBet(db, snow, erin, 'NO', 300, now - 3 * HOUR);
    tick(db, now - HOUR); // closes the trip market (and grants this week's allowance if the week turned)
    propose(db, trip, dev, 'YES', 'Erin posted the booking confirmation in the chat on Thursday evening.', now - HOUR);
    placeBet(db, run, femi, 'YES', 250, now - HOUR);
  })();
}
