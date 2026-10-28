import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { type DB, openDb } from '../src/db.ts';
import { getMarket, marketIdFromUrl } from '../src/domain/markets.ts';
import { balanceOf } from '../src/domain/points.ts';
import { ATTESTATIONS } from '../src/domain/rules.ts';
import { createUser, getUserByName } from '../src/domain/users.ts';
import { seedDemo } from '../src/seed.ts';
import { DAY } from '../src/time.ts';
import { T0 } from './helpers.ts';

const HOST = 'arblab.test';
const PASSWORD = 'correct horse';
const hash = bcrypt.hashSync(PASSWORD, 4);

let db: DB;
let now: number;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  now = T0;
  app = createApp({ db, secret: 'test-secret-test-secret-test-secret', clock: () => now, bcryptCost: 4, rng: () => 0 });
});

/** A browser-ish client: keeps cookies and sends same-origin form posts. */
function client() {
  const jar = new Map<string, string>();
  async function send(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('host', HOST);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await app.request(`http://${HOST}${path}`, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/max-age=0/i.test(c)) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }
  return {
    get: (path: string) => send(path),
    text: async (path: string) => (await send(path)).text(),
    post: (path: string, form: Record<string, string | string[]>, origin = `http://${HOST}`) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of [v].flat()) body.append(k, x);
      return send(path, { method: 'POST', body, headers: { origin, 'content-type': 'application/x-www-form-urlencoded' } });
    },
    async login(name: string) {
      const res = await this.post('/login', { name, password: PASSWORD });
      expect(res.status).toBe(303);
    },
  };
}

/** Every market's page, by its public id. */
const marketPaths = () => (db.prepare('SELECT public_id FROM markets ORDER BY id').all() as { public_id: string }[]).map((m) => `/markets/${m.public_id}`);

function member(name: string, admin = false): number {
  return createUser(db, { name, passwordHash: hash, isAdmin: admin, adult: true }, now);
}

const marketForm = (extra: Record<string, string> = {}) => ({
  question: 'Will Sam finish the crossword today?',
  criteria: 'YES if Sam posts a completed grid in the chat.',
  evidence_source: 'The group chat',
  close_local: '2026-10-27T12:00', // T0 + DAY
  timezone: 'UTC',
  attest: ATTESTATIONS.map((a) => a.key),
  ...extra,
});

describe('access', () => {
  it('sends visitors to the login page, except for the House Rules', async () => {
    const c = client();
    expect((await c.get('/')).headers.get('location')).toBe('/login');
    expect((await c.get('/markets/1')).status).toBe(303);
    expect(await c.text('/rules')).toContain('no cash value');
  });

  it('rejects wrong passwords and deactivated members', async () => {
    member('Admin', true);
    const bob = member('Bob');
    const c = client();
    expect((await c.post('/login', { name: 'Bob', password: 'nope' })).status).toBe(401);
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(bob);
    expect((await c.post('/login', { name: 'Bob', password: PASSWORD })).status).toBe(403);
  });

  const attempt = (name: string, password: string, headers: Record<string, string> = {}) =>
    app.request(`http://${HOST}/login`, {
      method: 'POST',
      body: new URLSearchParams({ name, password }),
      headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
  const from = (ip: string) => ({ 'cf-connecting-ip': ip });

  it('locks a name out for the address that failed 5 times, until the window passes', async () => {
    member('Bob');
    member('Cara');
    const attacker = from('203.0.113.9');
    for (let i = 0; i < 5; i++) expect((await attempt('Bob', 'nope', attacker)).status).toBe(401);
    const locked = await attempt('bob', PASSWORD, attacker);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await attempt('Cara', PASSWORD, attacker)).status).toBe(303); // other names are unaffected
    expect((await attempt('Bob', PASSWORD, from('198.51.100.7'))).status).toBe(303); // so is Bob, elsewhere
    now += 15 * 60_000 + 1;
    expect((await attempt('Bob', PASSWORD, attacker)).status).toBe(303);
  });

  it('limits one client address across many names', async () => {
    member('Bob');
    for (let i = 0; i < 20; i++) expect((await attempt(`ghost${i}`, 'nope', from('203.0.113.9'))).status).toBe(401);
    expect((await attempt('ghost-new', 'nope', from('203.0.113.9'))).status).toBe(429);
    expect((await attempt('Bob', PASSWORD, from('203.0.113.10'))).status).toBe(303);
  });

  it('backstops guessing at one name spread over many addresses', async () => {
    member('Bob');
    for (let i = 0; i < 30; i++) expect((await attempt('Bob', 'nope', from(`198.51.100.${i}`))).status).toBe(401);
    expect((await attempt('Bob', PASSWORD, from('192.0.2.1'))).status).toBe(429);
  });

  it('ignores a client-supplied Cf-Connecting-Ip when the peer is the host side (reverse proxy)', async () => {
    member('Bob');
    const viaHost = createApp({ db, secret: 'test-secret-test-secret-test-secret', clock: () => now, bcryptCost: 4, peerAddress: () => '::ffff:127.0.0.1' });
    const tryLogin = (password: string, cf: string) =>
      viaHost.request(`http://${HOST}/login`, {
        method: 'POST',
        body: new URLSearchParams({ name: 'Bob', password }),
        headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': cf, 'x-forwarded-for': '9.9.9.9, 100.64.0.5' },
      });
    for (let i = 0; i < 5; i++) expect((await tryLogin('nope', `10.9.9.${i}`)).status).toBe(401);
    expect((await tryLogin(PASSWORD, '10.9.9.99')).status).toBe(429);
  });

  it('treats members and made-up names identically, so a 429 does not reveal who is a member', async () => {
    member('Bob');
    const ip = from('203.0.113.9');
    for (const name of ['Bob', 'Ghost']) {
      for (let i = 0; i < 5; i++) expect((await attempt(name, 'nope', ip)).status).toBe(401);
      expect((await attempt(name, 'nope', ip)).status).toBe(429);
    }
    expect((await attempt('Other-ghost', 'nope', ip)).status).toBe(401);
  });

  it('clips long names when counting, so oversized names cannot fill memory but still count', async () => {
    const ip = from('203.0.113.9');
    const long = 'x'.repeat(5000);
    for (let i = 0; i < 5; i++) expect((await attempt(long + i, 'nope', ip)).status).toBe(401);
    expect((await attempt(long + 'z', 'nope', ip)).status).toBe(429);
  });

  it('lets the admin issue a reset link that sets a new password once', async () => {
    member('Admin', true);
    const bobId = member('Bob');
    const admin = client();
    await admin.login('Admin');

    const bob = client();
    await bob.login('Bob');
    expect((await bob.post(`/members/${bobId}/reset`, {})).status).toBe(303); // not an admin: refused
    expect((await bob.get('/me')).status).toBe(200);

    const page = await admin.post(`/members/${bobId}/reset`, {});
    expect(page.headers.get('cache-control')).toBe('no-store');
    const path = (await page.text()).match(/value="https?:\/\/[^/"]+(\/reset\/[\w-]+)"/)![1];

    const stranger = client();
    expect(await stranger.text(path)).toContain('Bob');
    expect((await stranger.post(path, { password: 'short', again: 'short' })).status).toBe(400);
    expect((await stranger.post(path, { password: 'a brand new password', again: 'different one!!' })).status).toBe(400);
    const done = await stranger.post(path, { password: 'a brand new password', again: 'a brand new password' });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/login');

    expect((await bob.get('/me')).status).toBe(303); // old session ended
    expect((await stranger.get(path)).status).toBe(404); // spent
    expect((await stranger.post('/login', { name: 'Bob', password: PASSWORD })).status).toBe(401);
    expect((await stranger.post('/login', { name: 'Bob', password: 'a brand new password' })).status).toBe(303);
  });

  it('rejects unknown and expired reset links', async () => {
    member('Admin', true);
    const bobId = member('Bob');
    expect((await client().get('/reset/nonsense')).status).toBe(404);
    const admin = client();
    await admin.login('Admin');
    const path = (await (await admin.post(`/members/${bobId}/reset`, {})).text()).match(/(\/reset\/[\w-]+)"/)![1];
    now += 61 * 60_000;
    expect((await client().get(path)).status).toBe(404);
  });

  it('revokes the session on the server at logout, so a copied cookie stops working', async () => {
    member('Bob');
    const cookie = (await attempt('Bob', PASSWORD)).headers.getSetCookie()[0].split(';')[0];
    const as = (path: string, init: RequestInit = {}) =>
      app.request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, origin: `http://${HOST}`, cookie } });
    expect((await as('/')).status).toBe(200);
    expect((await as('/logout', { method: 'POST' })).status).toBe(303);
    expect((await as('/')).status).toBe(303);
  });

  it('rejects oversized request bodies', async () => {
    const res = await client().post('/login', { name: 'Bob', password: 'x'.repeat(70_000) });
    expect(res.status).toBe(413);
  });

  it('uses a __Host- session cookie when cookies are secure', async () => {
    member('Bob');
    const secureApp = createApp({ db, secret: 'test-secret-test-secret-test-secret', clock: () => now, bcryptCost: 4, secureCookies: true });
    const res = await secureApp.request(`http://${HOST}/login`, {
      method: 'POST',
      body: new URLSearchParams({ name: 'Bob', password: PASSWORD }),
      headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookie = res.headers.getSetCookie().find((x) => x.includes('session'))!;
    expect(cookie).toMatch(/^__Host-session=/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
  });

  it('logs a member out everywhere once deactivated', async () => {
    member('Admin', true);
    member('Bob');
    const bob = client();
    await bob.login('Bob');
    expect((await bob.get('/')).status).toBe(200);
    const a = client();
    await a.login('Admin');
    await a.post(`/members/${getUserByName(db, 'Bob')!.id}/deactivate`, {});
    expect((await bob.get('/')).status).toBe(303);
  });

  it('blocks cross-site form posts', async () => {
    member('Admin', true);
    const c = client();
    await c.login('Admin');
    const res = await c.post('/invites', {}, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM invites').get()).toEqual({ n: 0 });
  });
});

describe('admins over HTTP', () => {
  it('lets the owner appoint admins from the Members page, and nobody else', async () => {
    const owner = createUser(db, { name: 'Owner', passwordHash: hash, isOwner: true, adult: true }, now);
    const bob = member('Bob');
    const cara = member('Cara');
    const o = client();
    await o.login('Owner');
    expect(await o.text('/members')).toContain(`action="/members/${bob}/make-admin"`);
    await o.post(`/members/${bob}/make-admin`, {});
    expect(await o.text('/members')).toContain('Bob is now an admin.');

    const b = client();
    await b.login('Bob');
    const page = await b.text('/members');
    expect(page).not.toContain('make-admin');
    expect(page).not.toContain(`/members/${owner}/`); // no buttons on the owner's row
    expect(page).toContain(`action="/members/${cara}/deactivate"`);
    await b.post(`/members/${cara}/make-admin`, {}); // hand-crafted: refused on the server
    expect(await b.text('/members')).toContain('Only the owner can appoint or remove admins.');
    await b.post(`/members/${owner}/reset`, {});
    expect(await b.text('/members')).toContain('only be reset on the server');
  });
});

describe('invites over HTTP', () => {
  it('lets a member invite a friend who signs up once', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    await a.post('/invites', {});
    const page = await a.text('/members');
    const token = page.match(/\/invite\/([\w-]+)/)![1];
    expect(page).toContain(`http://${HOST}/invite/${token}`);

    const friend = client();
    expect(await friend.text(`/invite/${token}`)).toContain('I confirm I am 18 or older');
    const noAdult = await friend.post(`/invite/${token}`, { name: 'Newbie', password: 'long enough' });
    expect(noAdult.status).toBe(400);
    const ok = await friend.post(`/invite/${token}`, { name: 'Newbie', password: 'long enough', adult: 'yes' });
    expect(ok.status).toBe(303);
    expect(await friend.text('/')).toContain('Log out Newbie');
    expect(balanceOf(db, getUserByName(db, 'Newbie')!.id)).toBe(1000);

    const again = await client().post(`/invite/${token}`, { name: 'Second', password: 'long enough', adult: 'yes' });
    expect(again.status).toBe(404);
    expect(getUserByName(db, 'Second')).toBeUndefined();
  });
});

describe('markets over HTTP', () => {
  it('enforces the subject betting block on the server', async () => {
    member('Admin', true);
    const sam = member('Sam');
    const a = client();
    await a.login('Admin');
    const created = await a.post('/markets', marketForm({ subject_id: String(sam) }));
    const path = created.headers.get('location')!;
    const id = marketIdFromUrl(db, path.split('/').pop()!);
    expect(getMarket(db, id).status).toBe('pending');

    const s = client();
    await s.login('Sam');
    await s.post(`${path}/subject`, { answer: 'accept' });
    expect(getMarket(db, id).status).toBe('open');
    expect(await s.text(path)).not.toContain('Place a bet');

    // Hand-crafted POST that the UI never offers:
    await s.post(`${path}/bet`, { side: 'YES', amount: '100' });
    expect(await s.text(path)).toContain('you cannot bet on it');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bets').get()).toEqual({ n: 0 });
    expect(balanceOf(db, sam)).toBe(1000);
  });

  it('requires the checklist and keeps the form filled in on error', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const res = await a.post('/markets', marketForm({ attest: 'no_harm' }));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Tick every item on the checklist');
    expect(body).toContain('Will Sam finish the crossword today?');
  });

  it('escapes member-written text', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const created = await a.post('/markets', marketForm({ question: '<script>alert(1)</script> will it?' }));
    const page = await a.text(created.headers.get('location')!);
    expect(page).not.toContain('<script>alert(1)');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('reads the close time in the chosen zone and shows the market in it', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const created = await a.post('/markets', marketForm({ close_local: '2026-10-28T09:00', timezone: 'Asia/Tokyo' }));
    const path = created.headers.get('location')!;
    const id = marketIdFromUrl(db, path.split('/').pop()!);
    expect(getMarket(db, id)).toMatchObject({ close_at: Date.UTC(2026, 9, 28, 0), timezone: 'Asia/Tokyo' });
    const page = await a.text(path);
    expect(page).toContain('data-zone="Asia/Tokyo"');
    expect(page).toContain('Japan &amp; Korea Time');
  });

  it('rejects a time zone it does not know', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const res = await a.post('/markets', marketForm({ timezone: 'Mars/Olympus_Mons' }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Pick a time zone');
  });

  it('offers one entry per time zone, with major cities, on the new market form', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const form = await a.text('/markets/new');
    expect(form).toContain('<option value="America/New_York" >UTC−04:00 Eastern Time (New York, Toronto, Miami, Atlanta)</option>');
    expect(form).toContain('<option value="UTC" selected>');
    expect(form).toContain('data-viewer-zone');
  });

  it('deletes a market only with the box ticked, then hides it but keeps its page', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const created = await a.post('/markets', marketForm());
    const path = created.headers.get('location')!;
    expect(await a.text(path)).toContain('Delete this market');
    await a.post(`${path}/delete`, {});
    expect(await a.text(path)).toContain('Tick the box');
    await a.post(`${path}/delete`, { confirm: 'yes' });
    const page = await a.text(path);
    expect(page).toContain('Admin deleted this market');
    expect(page).not.toContain('Delete this market');
    expect(await a.text('/?tab=resolved')).not.toContain(`href="${path}"`);
  });

  it('gives markets random ids, and sends links that use an old number to the new id', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const path = (await a.post('/markets', marketForm())).headers.get('location')!;
    expect(path).toMatch(/^\/markets\/[\w-]{8}$/);
    const id = marketIdFromUrl(db, path.split('/').pop()!);
    expect(await a.text(path)).not.toContain('Market #');
    expect((await a.get(`/markets/${id}`)).status).toBe(404); // new markets have no number to guess

    db.prepare('UPDATE markets SET old_number = 3 WHERE id = ?').run(id); // as if made before random ids
    const res = await a.get('/markets/3');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(path);
  });

  it('applies deadlines lazily on the next request', async () => {
    member('Admin', true);
    const a = client();
    await a.login('Admin');
    const created = await a.post('/markets', marketForm());
    const path = created.headers.get('location')!;
    const id = marketIdFromUrl(db, path.split('/').pop()!);
    now = T0 + 9 * DAY; // closed and 7 days without a proposal, with no timer running
    expect(await a.text(path)).toContain('Resolved VOID');
  });
});

describe('raffle', () => {
  it('lets members enter, draws when the minute ends, and refuses a bad entry', async () => {
    const a = member('Ann');
    const b = member('Bob');
    const ann = client();
    const bob = client();
    await ann.login('Ann');
    await bob.login('Bob');
    await ann.post('/raffle/enter', { amount: '300' });
    await bob.post('/raffle/enter', { amount: '200' });
    expect(await ann.text('/raffle')).toContain('Pot: <b>500 pts</b>');

    await bob.post('/raffle/enter', { amount: '5000' });
    await bob.get('/raffle/state'); // background polling must not swallow the message
    expect(await bob.text('/raffle')).toContain('Not enough points');

    const live = await ann.get('/raffle/state');
    expect(live.headers.get('cache-control')).toBe('no-store');
    expect(await live.json()).toMatchObject({ left: 30_000, balance: 700, balanceText: '700 pts' });

    now += 30_000; // rng is 0, so the first ticket (Ann's) wins
    const page = await ann.text('/raffle');
    expect(page).toContain('Recent draws');
    expect(balanceOf(db, a)).toBe(1200);
    expect(balanceOf(db, b)).toBe(800);
  });
});

describe('copy', () => {
  it('never mentions money anywhere in the app', async () => {
    seedDemo(db, now, hash);
    const a = client();
    expect(await a.text('/login')).not.toMatch(/\p{Sc}/u);
    await a.login('Alice');
    await a.post('/invites', {});
    const token = (await a.text('/members')).match(/\/invite\/([\w-]+)/)![1];
    const paths = [
      '/', '/?tab=awaiting', '/?tab=resolved', ...marketPaths(), '/markets/new',
      '/me', '/raffle', '/leaderboard', '/leaderboard?view=all', '/members', '/rules', `/invite/${token}`, '/nope',
    ];
    const banned = /\p{Sc}|\b(owes?|owed|settle up|dollars?|usd|wallet|payments?|venmo|paypal)\b/iu;
    for (const p of paths) {
      const page = await a.text(p);
      expect(page, p).toContain('<footer>');
      expect(page.match(banned), p).toBeNull();
    }
  });
});
