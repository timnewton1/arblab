import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { MAX_MEMBERS } from '../src/domain/rules.ts';
import {
  activeMemberCount,
  createInvite,
  createPasswordReset,
  getUser,
  redeemInvite,
  redeemPasswordReset,
  setActive,
  setAdmin,
  setOwner,
  usableReset,
} from '../src/domain/users.ts';
import { DAY, HOUR } from '../src/time.ts';
import { T0, addUser, setup } from './helpers.ts';

const newbie = (name: string) => ({ name, passwordHash: 'hash', adult: true });

describe('member cap', () => {
  it('stops at 50 active members', () => {
    const { db, ids } = setup(MAX_MEMBERS - 1);
    const invite = createInvite(db, ids[0], T0);
    const spare = createInvite(db, ids[0], T0);
    redeemInvite(db, invite.token, newbie('Fiftieth'), T0);
    expect(activeMemberCount(db)).toBe(50);

    expect(() => createInvite(db, ids[0], T0)).toThrow(/full/);
    expect(() => redeemInvite(db, spare.token, newbie('Fifty-first'), T0)).toThrow(/full/);
    expect(() => addUser(db, 'Sneaky')).toThrow(/full/);
    expect(activeMemberCount(db)).toBe(50);
  });

  it('frees a seat when a member is deactivated, and blocks reactivation when full', () => {
    const { db, ids } = setup(MAX_MEMBERS);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ids[0]);
    setActive(db, ids[0], ids[1], false);
    addUser(db, 'Replacement');
    expect(() => setActive(db, ids[0], ids[1], true)).toThrow(/full/);
  });
});

describe('invites', () => {
  it('are single-use', () => {
    const { db, ids } = setup(2);
    const inv = createInvite(db, ids[0], T0);
    redeemInvite(db, inv.token, newbie('Gina'), T0);
    expect(() => redeemInvite(db, inv.token, newbie('Hank'), T0)).toThrow(/already been used/);
  });

  it('expire after 7 days', () => {
    const { db, ids } = setup(1);
    const inv = createInvite(db, ids[0], T0);
    expect(() => redeemInvite(db, inv.token, newbie('Late'), T0 + 7 * DAY)).toThrow(/expired/);
  });

  it('require an 18+ confirmation and a unique name', () => {
    const { db, ids } = setup(1);
    const inv = createInvite(db, ids[0], T0);
    expect(() => redeemInvite(db, inv.token, { ...newbie('Kid'), adult: false }, T0)).toThrow(/18/);
    expect(() => redeemInvite(db, inv.token, newbie('user1'), T0)).toThrow(/taken/);
    redeemInvite(db, inv.token, newbie('Ivy'), T0); // the failed attempts did not use it up
  });

  it('only work while the inviter is active', () => {
    const { db, ids } = setup(2);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ids[0]);
    const inv = createInvite(db, ids[1], T0);
    setActive(db, ids[0], ids[1], false);
    expect(() => redeemInvite(db, inv.token, newbie('Jo'), T0)).toThrow(/no longer valid/);
  });
});

describe('admin', () => {
  it('only the admin can deactivate, and not themselves', () => {
    const db = openDb(':memory:');
    const admin = addUser(db, 'Admin');
    const bob = addUser(db, 'Bob');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin);
    expect(() => setActive(db, bob, admin, false)).toThrow(/Only an admin/);
    expect(() => setActive(db, admin, admin, false)).toThrow(/yourself/);
  });
});

describe('password reset links', () => {
  const admin = (db: ReturnType<typeof setup>['db'], id: number) => db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);

  it('are admin-only, single-use, expire after an hour and replace earlier links', () => {
    const { db, ids } = setup(3);
    admin(db, ids[0]);
    expect(() => createPasswordReset(db, ids[1], ids[2], T0)).toThrow(/admin/);

    const first = createPasswordReset(db, ids[0], ids[2], T0);
    const second = createPasswordReset(db, ids[0], ids[2], T0 + 1000);
    expect(() => usableReset(db, first.token, T0 + 1000)).toThrow(/not valid/);
    expect(usableReset(db, second.token, T0 + 1000).user.id).toBe(ids[2]);
    expect(() => usableReset(db, second.token, T0 + HOUR + 1000)).toThrow(/not valid/);

    redeemPasswordReset(db, second.token, 'new-hash', T0 + 2000);
    expect(() => redeemPasswordReset(db, second.token, 'again', T0 + 3000)).toThrow(/not valid/);
    expect(getUser(db, ids[2])!.password_hash).toBe('new-hash');
  });

  it('store only a hash of the token, and end the member\'s sessions', () => {
    const { db, ids } = setup(2);
    admin(db, ids[0]);
    const { token } = createPasswordReset(db, ids[0], ids[1], T0);
    expect(JSON.stringify(db.prepare('SELECT * FROM password_resets').all())).not.toContain(token);

    db.prepare('INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)').run('s1', ids[1], T0);
    const before = getUser(db, ids[1])!.session_version;
    redeemPasswordReset(db, token, 'h', T0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(getUser(db, ids[1])!.session_version).toBe(before + 1);
  });

  it('do not work for deactivated members', () => {
    const { db, ids } = setup(2);
    admin(db, ids[0]);
    expect(() => createPasswordReset(db, ids[0], ids[1], T0)).not.toThrow();
    setActive(db, ids[0], ids[1], false);
    expect(() => createPasswordReset(db, ids[0], ids[1], T0)).toThrow(/active/);
  });
});

describe('the owner and admins', () => {
  /** User1 owns the group, User2 is an admin, User3 and User4 are members. */
  function group() {
    const g = setup(4);
    g.db.prepare('UPDATE users SET is_owner = 1, is_admin = 1 WHERE id = ?').run(g.ids[0]);
    g.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(g.ids[1]);
    return { db: g.db, owner: g.ids[0], admin: g.ids[1], cara: g.ids[2], dan: g.ids[3] };
  }

  it('only the owner appoints and removes admins', () => {
    const { db, owner, admin, cara } = group();
    expect(() => setAdmin(db, admin, cara, true)).toThrow(/Only the owner/);
    setAdmin(db, owner, cara, true);
    expect(getUser(db, cara)!.is_admin).toBe(1);
    setAdmin(db, owner, cara, false);
    expect(getUser(db, cara)!.is_admin).toBe(0);
    expect(() => setAdmin(db, owner, owner, false)).toThrow(/always an admin/);
  });

  it('stops an admin taking over: they can deactivate members, but not admins or the owner', () => {
    const { db, owner, admin, cara, dan } = group();
    setAdmin(db, owner, cara, true);
    expect(() => setActive(db, admin, cara, false)).toThrow(/Only the owner can deactivate an admin/);
    expect(() => setActive(db, admin, owner, false)).toThrow(/owner cannot be deactivated/);
    expect(() => setAdmin(db, admin, owner, false)).toThrow(/Only the owner/);
    setActive(db, admin, dan, false);
    expect(getUser(db, dan)!.is_active).toBe(0);
    setActive(db, owner, cara, false); // the owner can
    expect(() => setAdmin(db, owner, cara, true)).toThrow(/active/);
  });

  it("stops an admin taking over through reset links: none for the owner, and only the owner's for admins", () => {
    const { db, owner, admin, cara } = group();
    expect(() => createPasswordReset(db, admin, owner, T0)).toThrow(/only be reset on the server/);
    expect(() => createPasswordReset(db, owner, owner, T0)).toThrow(/only be reset on the server/);
    setAdmin(db, owner, cara, true);
    expect(() => createPasswordReset(db, admin, cara, T0)).toThrow(/Only the owner can reset an admin/);
    expect(createPasswordReset(db, owner, cara, T0).token).toBeTruthy();
  });

  it('hands ownership over from the server, keeping the old owner an admin', () => {
    const { db, owner, cara } = group();
    setOwner(db, cara);
    expect(getUser(db, cara)).toMatchObject({ is_owner: 1, is_admin: 1 });
    expect(getUser(db, owner)).toMatchObject({ is_owner: 0, is_admin: 1 });
    expect(() => db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(owner)).toThrow(/UNIQUE/); // only ever one
  });

  it('makes the longest-standing admin of a group from before owners the owner', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'arblab-')), 'old.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, adult_confirmed_at INTEGER NOT NULL,
      invited_by INTEGER REFERENCES users(id), session_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    old.exec("INSERT INTO users (display_name, password_hash, is_admin, adult_confirmed_at, created_at) VALUES ('Ann', 'h', 1, 1, 1), ('Bea', 'h', 0, 1, 2)");
    old.close();
    const db = openDb(path);
    expect(db.prepare('SELECT display_name, is_owner FROM users ORDER BY id').all()).toEqual([
      { display_name: 'Ann', is_owner: 1 },
      { display_name: 'Bea', is_owner: 0 },
    ]);
    db.close();
  });
});
