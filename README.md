# Arblab

[![Tests](https://github.com/ConnorMilligan/arblab/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/ConnorMilligan/arblab/actions/workflows/test.yml)

A small, invite-only prediction market for a group of friends (up to 50). Members bet
**play points** on yes/no questions, resolve them with a bonded propose/dispute/jury
process, and compare results on a leaderboard.

Points have no cash value. They cannot be bought, sold, transferred, redeemed or cashed
out, and real-money side bets are not part of the app.

One Node process, one SQLite file, server-rendered HTML, one CSS file, no client framework
and no build step. The design and the rule interpretations are in [PLAN.md](PLAN.md).

## Run with Docker

Needs Docker with the Compose plugin. Everything runs in one container, and the SQLite file lives
on the `arblab-data` volume.

```sh
cp .env.example .env
sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
docker compose up -d --build                                          # http://localhost:8080
docker compose exec arblab node src/cli.ts create-admin YourName --adult  # prints a generated password
```

Everyone else joins through single-use invite links from the Members page. To try it with demo data
instead, run `docker compose exec arblab node src/cli.ts seed-demo` on an empty database
(6 members, password "demo-password", Alice is the owner, plus 3 markets).

To update after pulling new code: `docker compose up -d --build`. The volume keeps the data.

## Commands

Run these inside the container: `docker compose exec arblab node src/cli.ts <command>`.

| Command | What it does |
| --- | --- |
| `create-admin <name> --adult` | Create the first member, the owner. Only works on an empty database. Set `ADMIN_PASSWORD` to choose the password. |
| `reset-password <name>` | Print a new password for a member. For the owner's own forgotten password, or when the web portal isn't an option. |
| `set-owner <name>` | Hand ownership to another member. The owner appoints and removes admins; the previous owner stays an admin. |
| `seed-demo` | Fill an empty database with demo data |
| `backup <file>` | Write a consistent copy of the database |

Other useful ones: `docker compose logs -f` to follow the log, `docker compose ps` for the health status.

## Configuration

Set these in `.env`; `compose.yaml` passes them through.

| Variable | Default | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | | **Required**, at least 32 characters: `openssl rand -hex 32` |
| `APP_URL` | from the request | Public base URL used in invite links, e.g. `https://arblab.example.com` |
| `ARBLAB_BIND` | `127.0.0.1` | Host address to publish on. `0.0.0.0` exposes it to the network. |
| `ARBLAB_PORT` | `8080` | Host port to publish on |
| `SECURE_COOKIES` | `true` in the image | Cookies are HTTPS-only. Set `false` only to serve plain HTTP to other devices (e.g. `http://192.168.1.20:8080` at home). `localhost` works either way. |

The image also sets `NODE_ENV=production`, `PORT=8080` and `DATABASE_PATH=/data/arblab.db`.

## Deploy

Run exactly one container: SQLite is a single file on a single disk.

On your own server, use the same `docker compose up -d --build`, keep `ARBLAB_BIND=127.0.0.1`, and
put a reverse proxy that handles HTTPS (Caddy, nginx, Traefik) in front of port 8080. The container
has a built-in health check on `/healthz`, a read-only filesystem apart from `/data` and `/tmp`, and
no Linux capabilities.

### Backups

All state is in one file. Write a copy into the volume, then copy it out of the container:

```sh
docker compose exec arblab node src/cli.ts backup /data/backup.db
docker compose cp arblab:/data/backup.db ./arblab-$(date +%F).db
```

### Other hosts

The same `Dockerfile` works anywhere that runs containers with a persistent volume at `/data`:

- **Fly.io**: set a unique `app` in `fly.toml`, then `fly launch --copy-config --no-deploy`,
  `fly volumes create arblab_data --size 1 --region lhr`, `fly secrets set SESSION_SECRET=$(openssl rand -hex 32)`,
  `fly deploy`, and `fly ssh console -C "node src/cli.ts create-admin YourName --adult"`.
- **Railway**: create a project from this repo, add a volume at `/data`, set `SESSION_SECRET`, then
  `railway ssh` and run `node src/cli.ts create-admin YourName --adult`.
- **Podman + systemd**: `deploy/arblab.container` and `deploy/arblab.network` are Quadlet units;
  `deploy/update.sh` rebuilds and restarts them.

## Development

Needs Node 22.18 or newer (Node runs the TypeScript directly, no build step).

```sh
npm install
npm run cli -- seed-demo   # demo data in data/arblab.db
npm run dev                # http://localhost:3000, restarts on file changes
npm test                   # vitest
npm run typecheck          # tsc --noEmit
```

Outside Docker the defaults are `PORT=3000`, `DATABASE_PATH=data/arblab.db`, and a random
`SESSION_SECRET` per start unless `NODE_ENV=production`.

## How it works

```
src/server.ts        entry point: opens the DB, serves HTTP, runs the deadline check every 5 s
src/app.ts           routes, signed-cookie sessions, same-origin check for form posts
src/db.ts            schema; the ledger is append-only (UPDATE/DELETE triggers abort)
src/domain/          every rule, as plain functions taking (db, ..., now)
  points.ts          ledger, derived balances, weekly allowance, leaderboard
  users.ts           invites, 50-member cap, deactivation
  markets.ts         creation + checklist, subject opt-in, bets, final payout
  payout.ts          pure parimutuel math (rounding and leftover points)
  raffle.ts          stake-weighted raffles every 30 seconds: entries and draws
  resolution.ts      proposals, disputes, jury draw, voting, bond forfeiture
  tick.ts            applies every deadline that has passed; safe to run repeatedly
src/views/           HTML templates (tagged template literals with auto-escaping)
public/              style.css, app.js (time zone pickers, local times, live clocks)
test/                vitest: domain rules plus HTTP tests against the real app
```

- **Balances** are always `SUM(amount)` over the ledger, so there is no cached balance to drift.
- **Every rule is enforced on the server** in `src/domain/`. The UI hides forms you can't use,
  but the tests post directly to show the server refuses them anyway.
- **Deadlines** (close, the 24-hour challenge window, 7-day and 72-hour auto-void, Monday allowance)
  are applied by `tick()` before each request and every 5 seconds. Each step only touches rows still in
  the earlier state, so running it twice changes nothing.

## Dependencies

Runtime (4):

- **hono**: routing, signed cookies and security headers, all built in.
- **@hono/node-server**: the adapter that runs Hono on Node's HTTP server.
- **better-sqlite3**: synchronous SQLite, so a transaction is just a function call. Prebuilt
  binaries ship inside the package, so nothing is compiled.
- **bcryptjs**: bcrypt password hashing in pure JS, with no native build and no dependencies of its own.

Dev (4): **typescript** (type checking only), **vitest**, **@types/node**, **@types/better-sqlite3**.

The client needs nothing: plain forms plus a 25-line script that only adds conveniences.

## Interpretations

The spec left a few things open. These are the choices made (more detail in PLAN.md):

- The **5,000 cap** limits the allowance top-up. Winnings can take a balance above 5,000.
- The **50-member cap** counts active members, so deactivating someone frees a seat.
- **New members** get the current week's 1,000 points when they join.
- A **dispute** says the proposal is wrong. If the jury picks the proposed outcome the disputer
  forfeits; if it picks anything else (including a third option) the proposer forfeits.
- **No jury decision** (no quorum or no 2/3 majority by 72 hours): VOID, and both bonds are returned.
- **Fewer than 3 eligible jurors**: the dispute voids the market at once and both bonds are
  returned. The dispute form warns about this before you post.
- **Nobody backed the winning side**: every stake is refunded.
- **Bonds** are 10% of the pool rounded up, with a 50-point minimum.
- **Weeks** (allowance and the 3-disputes limit) start Monday 00:00 UTC. **Seasons** are calendar quarters.
- **Votes** are final once cast. Voting closes early when every juror has voted.
- **Bets are public**. Jurors' names and votes stay hidden until voting closes.
- The **subject** can be the market's creator (that counts as opting in), can propose an outcome,
  and can never bet or sit on the jury. A subject who declines voids the market.

## Simplified or left out

- No email: no notifications (a "Needs you" box on the home page lists opt-ins and jury duty), and
  no self-service password reset. A member who forgot their password asks the admin, who clicks
  "Reset link" next to their name on the Members page and sends them the link privately. The link works
  once, expires after an hour, is stored only as a hash, replaces any earlier link, and ends the
  member's sessions when used. Only the owner can make one for an admin, and the owner's own password is
  reset with the `reset-password` CLI command.
- Login rate limiting counts failures in memory over 15 minutes: 5 per name from one client address, 20 per address, and 30 per name overall. The address comes from `X-Forwarded-For` when the request comes from the host-side proxy, and from `Cf-Connecting-Ip` otherwise. There is no global cap, so one client cannot pause logins for everyone. A restart clears the counts.
- Sessions are server-side rows: logging out, changing a password or deactivating a member revokes them.
- Markets and bets can't be edited once created. No comments or discussion. A market's creator can delete
  it while nobody else has bet and no outcome has been proposed; an admin can delete any market that isn't
  resolved. Deleting voids it, returns every stake and bond, and hides it from the lists and leaderboard.
- No pagination. Lists show up to 200 rows.
- No migration tool. The schema is `CREATE TABLE IF NOT EXISTS`, so a future schema change needs a
  small migration step.
- If the server is down over several Mondays, only the current week's allowance is granted when it
  comes back; missed weeks aren't paid retroactively.
- Times render in UTC on the server and switch to the viewer's time zone in the browser. That is the
  device's zone unless they pick another from the footer; the choice is saved per browser (not per
  account). Each market has its own zone, chosen when it's created: its times show in the viewer's zone
  first, with the market's local time underneath when that differs. Without JavaScript, times stay UTC
  and a new market's zone starts on UTC.
- The "no money talk" check on member-written text is a regex (currency symbols plus a short word
  list), not a moderation system.
- CSRF protection is `SameSite=Lax` cookies plus an `Origin` check, not per-form tokens.
- The container runs as root so it can write to a freshly mounted volume without extra setup;
  `compose.yaml` drops all capabilities and makes the rest of the filesystem read-only.
