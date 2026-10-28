import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newPublicId } from './ids.ts';

export type DB = Database.Database;

// All times are integer milliseconds since the epoch (UTC).
function ledgerTable(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('allowance', 'stake', 'winnings', 'refund', 'bond', 'bond_return', 'jury_reward', 'raffle_stake', 'raffle_win')),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  market_id INTEGER REFERENCES markets(id),
  created_at INTEGER NOT NULL,
  CHECK ((type IN ('stake', 'bond', 'raffle_stake')) = (amount < 0)),
  CHECK ((type IN ('allowance', 'raffle_stake', 'raffle_win')) = (market_id IS NULL))
);`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)), -- the one member who appoints and removes admins
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  adult_confirmed_at INTEGER NOT NULL,
  invited_by INTEGER REFERENCES users(id),
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_one_owner ON users(is_owner) WHERE is_owner = 1;

-- One row per login. The cookie names a row, so logging out revokes it server-side.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- Admin-issued, single-use password reset links. Only a hash of the token is stored.
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  used_by INTEGER UNIQUE REFERENCES users(id),
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY, -- internal only; pages and links use public_id
  public_id TEXT NOT NULL, -- random, e.g. k3J9xQpL
  old_number INTEGER, -- the id its links used before markets had random ids
  creator_id INTEGER NOT NULL REFERENCES users(id),
  question TEXT NOT NULL,
  criteria TEXT NOT NULL,
  evidence_source TEXT NOT NULL,
  close_at INTEGER NOT NULL,
  timezone TEXT, -- IANA zone the market's times are shown in; NULL for markets made before zones
  subject_id INTEGER REFERENCES users(id),
  subject_opted_in_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'open', 'closed', 'proposed', 'disputed', 'resolved')),
  outcome TEXT CHECK (outcome IN ('YES', 'NO', 'VOID')),
  resolution_note TEXT,
  resolved_at INTEGER,
  attestation TEXT NOT NULL,
  attested_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER, -- deleted markets are VOID with everything returned, and hidden from the lists
  deleted_by INTEGER REFERENCES users(id),
  CHECK ((status = 'resolved') = (outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS markets_status ON markets(status);
CREATE UNIQUE INDEX IF NOT EXISTS markets_public_id ON markets(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS markets_old_number ON markets(old_number);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bets_market ON bets(market_id);
CREATE INDEX IF NOT EXISTS bets_user ON bets(user_id);

-- Every balance change. Balances are SUM(amount); rows are never updated or deleted.
${ledgerTable('ledger')}
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id);
CREATE INDEX IF NOT EXISTS ledger_market ON ledger(market_id);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

-- One row per member per week, so the Monday allowance is granted at most once.
CREATE TABLE IF NOT EXISTS allowances (
  user_id INTEGER NOT NULL REFERENCES users(id),
  week_start INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, week_start)
);

CREATE TABLE IF NOT EXISTS proposals (
  market_id INTEGER PRIMARY KEY REFERENCES markets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('YES', 'NO', 'VOID')),
  note TEXT NOT NULL,
  bond INTEGER NOT NULL CHECK (bond > 0),
  created_at INTEGER NOT NULL,
  challenge_ends_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  market_id INTEGER PRIMARY KEY REFERENCES markets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  bond INTEGER NOT NULL CHECK (bond > 0),
  created_at INTEGER NOT NULL,
  voting_ends_at INTEGER NOT NULL,
  closed_at INTEGER,
  jury_outcome TEXT CHECK (jury_outcome IN ('YES', 'NO', 'VOID'))
);
CREATE INDEX IF NOT EXISTS disputes_user ON disputes(user_id, created_at);

CREATE TABLE IF NOT EXISTS jurors (
  market_id INTEGER NOT NULL REFERENCES markets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  drawn_at INTEGER NOT NULL,
  vote TEXT CHECK (vote IN ('YES', 'NO', 'VOID')),
  voted_at INTEGER,
  PRIMARY KEY (market_id, user_id)
);

-- Raffle rounds are the 30-second window starting at round (ms). A member has one entry per round; entering again adds to it.
CREATE TABLE IF NOT EXISTS raffle_entries (
  round INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  PRIMARY KEY (round, user_id)
);

-- One row per round that had entries; its presence is what stops a round being drawn twice.
CREATE TABLE IF NOT EXISTS raffle_draws (
  round INTEGER PRIMARY KEY,
  winner_id INTEGER NOT NULL REFERENCES users(id),
  pot INTEGER NOT NULL,
  ticket INTEGER NOT NULL,
  entrants INTEGER NOT NULL,
  drawn_at INTEGER NOT NULL
);
`;

/** Databases made before raffles have a ledger whose CHECKs reject the raffle types: rebuild it. */
function migrateLedger(db: DB): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes('raffle_win')) return;
  db.transaction(() => {
    db.exec(ledgerTable('ledger_new'));
    db.exec('INSERT INTO ledger_new SELECT id, user_id, type, amount, market_id, created_at FROM ledger');
    db.exec('DROP TABLE ledger'); // takes its indexes and triggers with it; SCHEMA recreates them
    db.exec('ALTER TABLE ledger_new RENAME TO ledger');
  })();
}

/** Adds a column that older databases lack (the table itself may not exist yet; SCHEMA creates it). */
function addColumn(db: DB, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Markets made before random ids get one, and keep their number so old links still lead to them. */
function giveMarketsPublicIds(db: DB): void {
  const cols = (db.prepare('PRAGMA table_info(markets)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.length || cols.includes('public_id')) return;
  db.transaction(() => {
    db.exec('ALTER TABLE markets ADD COLUMN public_id TEXT');
    db.exec('ALTER TABLE markets ADD COLUMN old_number INTEGER');
    const give = db.prepare('UPDATE markets SET public_id = ?, old_number = id WHERE id = ?');
    for (const { id } of db.prepare('SELECT id FROM markets').all() as { id: number }[]) give.run(newPublicId(), id);
  })();
}

/** Groups from before owners: the longest-standing active admin becomes the owner. */
function appointFirstOwner(db: DB): void {
  const cols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.length || cols.includes('is_owner')) return;
  db.transaction(() => {
    db.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1))');
    db.exec(`UPDATE users SET is_owner = 1
             WHERE id = (SELECT id FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY created_at, id LIMIT 1)`);
  })();
}

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrateLedger(db);
  addColumn(db, 'markets', 'timezone', 'TEXT'); // market time zones
  addColumn(db, 'markets', 'deleted_at', 'INTEGER'); // deleting markets
  addColumn(db, 'markets', 'deleted_by', 'INTEGER REFERENCES users(id)');
  giveMarketsPublicIds(db);
  appointFirstOwner(db);
  db.exec(SCHEMA);
  return db;
}
