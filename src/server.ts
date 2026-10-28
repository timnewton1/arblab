import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.ts';
import { openDb } from './db.ts';
import { tick } from './domain/tick.ts';

const production = process.env.NODE_ENV === 'production';
const dbPath = process.env.DATABASE_PATH ?? 'data/arblab.db';
let secret = process.env.SESSION_SECRET ?? '';
if (secret.length < 32) {
  if (production) {
    console.error('SESSION_SECRET must be set to at least 32 random characters.');
    process.exit(1);
  }
  secret = randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set: using a random one, so sessions end when the server restarts.');
}

// Cookies are HTTPS-only in production; SECURE_COOKIES=false allows plain HTTP (e.g. a LAN-only container).
const secureCookies = process.env.SECURE_COOKIES ? process.env.SECURE_COOKIES !== 'false' : production;
if (production && !secureCookies) console.warn('SECURE_COOKIES=false: session cookies will be sent over plain HTTP.');

const db = openDb(dbPath);
const app = createApp({ db, secret, secureCookies, appUrl: process.env.APP_URL });

// Deadlines are also checked before every request; this catches quiet periods and draws raffles promptly.
const timer = setInterval(() => {
  try {
    tick(db, Date.now());
  } catch (err) {
    console.error('tick failed', err);
  }
}, 5_000);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => console.log(`Listening on http://localhost:${info.port} (db: ${dbPath})`));

// better-sqlite3 is synchronous, so no transaction can be half-done when a signal arrives.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    db.close();
    process.exit(0);
  });
}
