import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import {
  createMarket,
  getMarket,
  marketIdFromUrl,
  placeBet,
  pools,
  publicIdForOldNumber,
  respondAsSubject,
} from '../src/domain/markets.ts';
import { tick } from '../src/domain/tick.ts';
import { DAY, TIME_ZONES, timeZoneOptions, wallTimeToEpoch, zoneName } from '../src/time.ts';
import { T0, makeMarket, setup } from './helpers.ts';

describe('creating markets', () => {
  it('requires every checklist item and stores the attestation', () => {
    const { db, ids } = setup(1);
    const input = {
      question: 'Will it snow in town before New Year?',
      criteria: 'YES if the Met Office reports snow at the town station.',
      evidenceSource: 'Met Office',
      closeAt: T0 + DAY,
      timeZone: 'UTC',
      subjectId: null,
    };
    expect(() => createMarket(db, ids[0], { ...input, attestations: ['no_harm', 'no_crime'] }, T0)).toThrow(/checklist/);
    const id = createMarket(db, ids[0], { ...input, attestations: ['no_harm', 'no_crime', 'no_minors'] }, T0);
    const m = getMarket(db, id);
    expect(JSON.parse(m.attestation)).toHaveLength(3);
    expect(m.attested_at).toBe(T0);
  });

  it('rejects money talk in market text', () => {
    const { db, ids } = setup(1);
    expect(() =>
      createMarket(
        db,
        ids[0],
        { question: 'Loser owes the winner $20?', criteria: 'Self-evident really', evidenceSource: 'Us', closeAt: T0 + DAY, timeZone: 'UTC', subjectId: null, attestations: ['no_harm', 'no_crime', 'no_minors'] },
        T0,
      ),
    ).toThrow(/play points/);
  });
});

describe('subjects', () => {
  it('keeps the market pending until the subject opts in', () => {
    const { db, ids } = setup(3);
    const [creator, subject, other] = ids;
    const m = makeMarket(db, creator, { subjectId: subject });
    expect(getMarket(db, m).status).toBe('pending');
    expect(() => placeBet(db, m, other, 'YES', 10, T0)).toThrow(/opt in/);
    expect(() => respondAsSubject(db, m, other, true, T0)).toThrow(/Only the subject/);
    respondAsSubject(db, m, subject, true, T0);
    placeBet(db, m, other, 'YES', 10, T0);
    expect(pools(db, m).yes).toBe(10);
  });

  it('never lets the subject bet', () => {
    const { db, ids, bal } = setup(2);
    const [creator, subject] = ids;
    const m = makeMarket(db, creator, { subjectId: subject });
    respondAsSubject(db, m, subject, true, T0);
    expect(() => placeBet(db, m, subject, 'YES', 10, T0)).toThrow(/subject/);
    expect(() => placeBet(db, m, subject, 'NO', 10, T0)).toThrow(/subject/);
    expect(bal(subject)).toBe(1000);
    expect(pools(db, m).total).toBe(0);
  });

  it('treats naming yourself as opting in, and still blocks your bets', () => {
    const { db, ids } = setup(1);
    const m = makeMarket(db, ids[0], { subjectId: ids[0] });
    expect(getMarket(db, m).status).toBe('open');
    expect(() => placeBet(db, m, ids[0], 'YES', 10, T0)).toThrow(/subject/);
  });

  it('voids the market if the subject declines or never answers', () => {
    const { db, ids } = setup(2);
    const declined = makeMarket(db, ids[0], { subjectId: ids[1] });
    const ignored = makeMarket(db, ids[0], { subjectId: ids[1] });
    respondAsSubject(db, declined, ids[1], false, T0);
    expect(getMarket(db, declined)).toMatchObject({ status: 'resolved', outcome: 'VOID' });
    tick(db, T0 + DAY);
    expect(getMarket(db, ignored)).toMatchObject({ status: 'resolved', outcome: 'VOID' });
  });
});

describe('betting', () => {
  it('debits the stake and refuses to overdraw', () => {
    const { db, ids, bal } = setup(1);
    const m = makeMarket(db, ids[0]);
    placeBet(db, m, ids[0], 'NO', 400, T0);
    expect(bal(ids[0])).toBe(600);
    expect(() => placeBet(db, m, ids[0], 'NO', 601, T0)).toThrow(/Not enough points/);
    expect(() => placeBet(db, m, ids[0], 'NO', 1.5, T0)).toThrow(/whole number/);
    expect(() => placeBet(db, m, ids[0], 'NO', 0, T0)).toThrow(/whole number/);
  });

  it('stops at the close time even before the tick has run', () => {
    const { db, ids } = setup(1);
    const m = makeMarket(db, ids[0]);
    expect(() => placeBet(db, m, ids[0], 'YES', 10, T0 + DAY)).toThrow(/closed/);
  });

  it('refuses deactivated members', () => {
    const { db, ids } = setup(2);
    const m = makeMarket(db, ids[0]);
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(ids[1]);
    expect(() => placeBet(db, m, ids[1], 'YES', 10, T0)).toThrow(/not active/);
  });
});

describe('time zones', () => {
  it('turns a wall-clock time in a zone into an instant, across DST changes', () => {
    expect(wallTimeToEpoch('2026-10-30T17:00', 'Asia/Tokyo')).toBe(Date.UTC(2026, 9, 30, 8));
    expect(wallTimeToEpoch('2026-10-30T17:00', 'UTC')).toBe(Date.UTC(2026, 9, 30, 17));
    // New York is on EDT (UTC-4) before Nov 1 2026 and EST (UTC-5) after.
    expect(wallTimeToEpoch('2026-10-31T12:00', 'America/New_York')).toBe(Date.UTC(2026, 9, 31, 16));
    expect(wallTimeToEpoch('2026-11-02T12:00', 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 17));
    expect(wallTimeToEpoch('2026-03-29T12:00', 'Asia/Kolkata')).toBe(Date.UTC(2026, 2, 29, 6, 30));
    expect(wallTimeToEpoch('not a time', 'UTC')).toBeNaN();
    expect(wallTimeToEpoch('2026-10-30T17:00', 'Nowhere/Special')).toBeNaN();
    expect(wallTimeToEpoch('2026-03-29T12:00', 'Asia/Calcutta')).toBeNaN(); // offered under its current name only
  });

  it('lists each zone once, west to east, with its offset and major cities', () => {
    const options = timeZoneOptions(T0);
    expect(options).toHaveLength(TIME_ZONES.length);
    expect(new Set(options.map((o) => o.zone)).size).toBe(options.length);
    expect(options[0].label).toBe('UTC−11:00 Samoa Time (Pago Pago, Midway)');
    expect(options.find((o) => o.zone === 'Europe/Paris')!.label).toBe(
      'UTC+01:00 Central European Time (Berlin, Paris, Madrid, Rome, Amsterdam, Warsaw)',
    );
    expect(options.find((o) => o.zone === 'UTC')!.label).toMatch(/^UTC\+00:00 Coordinated Universal Time/);
  });

  it('names zones', () => {
    expect(zoneName('Asia/Tokyo')).toBe('Japan & Korea Time');
    expect(zoneName('America/Argentina/Buenos_Aires')).toBe('Buenos Aires time'); // not in the list
  });

  it('requires a known zone and stores it', () => {
    const { db, ids } = setup(1);
    expect(getMarket(db, makeMarket(db, ids[0])).timezone).toBe('UTC');
    expect(() =>
      createMarket(
        db,
        ids[0],
        { question: 'Will it snow in town before New Year?', criteria: 'YES if the Met Office reports snow.', evidenceSource: 'Met Office', closeAt: T0 + DAY, timeZone: 'Nowhere/Special', subjectId: null, attestations: ['no_harm', 'no_crime', 'no_minors'] },
        T0,
      ),
    ).toThrow(/time zone/);
  });
});

describe('migrations', () => {
  it('adds the time zone column to a database from before market zones', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'arblab-')), 'old.db');
    const old = new Database(path);
    old.exec('CREATE TABLE markets (id INTEGER PRIMARY KEY, close_at INTEGER NOT NULL, status TEXT NOT NULL)');
    old.exec("INSERT INTO markets (close_at, status) VALUES (1, 'open')");
    old.close();
    const db = openDb(path);
    expect(db.prepare('SELECT timezone FROM markets').get()).toEqual({ timezone: null });
    db.close();
  });
});

describe('public ids', () => {
  it('gives markets in a database from before random ids one, and keeps their number for old links', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'arblab-')), 'old.db');
    const old = new Database(path);
    old.exec('CREATE TABLE markets (id INTEGER PRIMARY KEY, close_at INTEGER NOT NULL, status TEXT NOT NULL)');
    old.exec("INSERT INTO markets (close_at, status) VALUES (1, 'open'), (2, 'open')");
    old.close();
    const db = openDb(path);
    const rows = db.prepare('SELECT id, public_id, old_number FROM markets ORDER BY id').all() as { id: number; public_id: string; old_number: number }[];
    expect(rows.map((r) => r.old_number)).toEqual([1, 2]);
    expect(new Set(rows.map((r) => r.public_id)).size).toBe(2);
    expect(marketIdFromUrl(db, rows[1].public_id)).toBe(2);
    expect(publicIdForOldNumber(db, 1)).toBe(rows[0].public_id);
    db.close();
  });
});
