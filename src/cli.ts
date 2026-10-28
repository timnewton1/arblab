import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.ts';
import { RuleError } from './domain/rules.ts';
import { createUser, getUserByName, setOwner, setPasswordHash, validatePassword } from './domain/users.ts';
import { DEMO_NAMES, seedDemo } from './seed.ts';

const USAGE = `Usage: node src/cli.ts <command>

  create-admin <name> --adult   Create the first member (the owner). Uses ADMIN_PASSWORD
                                if set, otherwise prints a generated password.
                                --adult confirms the admin is 18 or older.
  reset-password <name>         Give a member a new random password and print it.
  set-owner <name>              Hand ownership (appointing and removing admins) to the member called
                                <name>. The previous owner stays an admin.
  seed-demo                     Fill an empty database with 6 demo members and 3 markets.
  backup <file>                 Write a consistent copy of the database to <file>.

The database is DATABASE_PATH (default data/arblab.db).`;

const DEMO_PASSWORD = 'demo-password';
const COST = 11;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const db = openDb(process.env.DATABASE_PATH ?? 'data/arblab.db');
const memberCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
const newPassword = () => randomBytes(9).toString('base64url');

try {
  switch (command) {
    case 'create-admin': {
      if (!name || !args.includes('--adult')) fail(USAGE);
      if (memberCount > 0) fail('There are already members. Everyone after the first joins with an invite link.');
      const password = process.env.ADMIN_PASSWORD || newPassword();
      validatePassword(password);
      createUser(db, { name, passwordHash: bcrypt.hashSync(password, COST), isOwner: true, adult: true }, Date.now());
      console.log(`Created "${name}", the owner.`);
      if (!process.env.ADMIN_PASSWORD) console.log(`Password: ${password}`);
      break;
    }
    case 'reset-password': {
      if (!name) fail(USAGE);
      const user = getUserByName(db, name) ?? fail(`No member called "${name}".`);
      const password = newPassword();
      setPasswordHash(db, user.id, bcrypt.hashSync(password, COST));
      console.log(`New password for ${user.display_name}: ${password}`);
      break;
    }
    case 'set-owner': {
      if (!name) fail(USAGE);
      const user = getUserByName(db, name) ?? fail(`No member called "${name}".`);
      setOwner(db, user.id);
      console.log(`${user.display_name} is now the owner.`);
      break;
    }
    case 'seed-demo': {
      if (memberCount > 0) fail('seed-demo only runs on an empty database.');
      seedDemo(db, Date.now(), bcrypt.hashSync(DEMO_PASSWORD, COST));
      console.log(`Seeded ${DEMO_NAMES.join(', ')} (password "${DEMO_PASSWORD}", Alice is the owner) and 3 markets.`);
      break;
    }
    case 'backup': {
      if (!name) fail(USAGE);
      await db.backup(name);
      console.log(`Backed up to ${name}.`);
      break;
    }
    default:
      fail(USAGE);
  }
} catch (err) {
  if (err instanceof RuleError) fail(err.message);
  throw err;
} finally {
  db.close();
}
