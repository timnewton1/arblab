import type { Position } from '../domain/markets.ts';
import { LEDGER_LABELS, type LeaderRow, type LedgerRow } from '../domain/points.ts';
import {
  ALLOWANCE_CAP,
  DISPUTES_PER_WEEK,
  MAX_MEMBERS,
  MIN_BOND,
  WEEKLY_ALLOWANCE,
} from '../domain/rules.ts';
import type { Invite, MemberRow } from '../domain/users.ts';
import { type Html, html } from '../html.ts';
import { APP_NAME, type PageCtx, page, pts, signed, when } from './layout.ts';

export function loginPage(ctx: PageCtx, name = ''): string {
  return page(
    ctx,
    'Log in',
    html`<h1>Log in</h1>
<form method="post" action="/login" class="stack narrow">
  <label>Display name <input name="name" required autocomplete="username" value="${name}"></label>
  <label>Password <input type="password" name="password" required autocomplete="current-password"></label>
  <button>Log in</button>
</form>
<p class="muted">${APP_NAME} is invite-only. Ask a member for an invite link. Forgot your password? Ask the admin for a reset link.</p>`,
  );
}

export function signupPage(ctx: PageCtx, token: string, inviter: string, name = ''): string {
  return page(
    ctx,
    'Join',
    html`<h1>Join ${APP_NAME}</h1>
<p>${inviter} invited you to a private prediction market for friends. It runs on play points only:
   they have no cash value and can't be bought, sold, transferred or redeemed. Read the <a href="/rules">House Rules</a>.</p>
<form method="post" action="/invite/${token}" class="stack narrow">
  <label>Display name <small>2–24 characters. Others will see this.</small>
    <input name="name" required minlength="2" maxlength="24" value="${name}" autocomplete="username"></label>
  <label>Password <small>At least 8 characters.</small>
    <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
  <label class="check"><input type="checkbox" name="adult" value="yes" required> I confirm I am 18 or older.</label>
  <button>Join</button>
</form>`,
  );
}

export function resetPage(ctx: PageCtx, token: string, name: string): string {
  return page(
    ctx,
    'Reset password',
    html`<h1>Reset password</h1>
<p>Choose a new password for <b>${name}</b>. You will be logged out everywhere and asked to log in again.</p>
<form method="post" action="/reset/${token}" class="stack narrow">
  <label>New password <small>At least 8 characters.</small>
    <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
  <label>Repeat it <input type="password" name="again" required minlength="8" autocomplete="new-password"></label>
  <button>Set password</button>
</form>`,
  );
}

export function resetLinkPage(ctx: PageCtx, name: string, link: string, expiresAt: number): string {
  return page(
    ctx,
    'Reset link',
    html`<h1>Reset link for ${name}</h1>
<p>Send this to ${name} privately (not in a group chat). It works once and expires ${when(expiresAt)}.
   It is shown only now. Making another link for ${name} cancels this one.</p>
<ul class="invites"><li><input readonly value="${link}" aria-label="Reset link"></li></ul>
<p><a href="/members">Back to members</a></p>`,
  );
}

export function messagePage(ctx: PageCtx, title: string, message: string): string {
  return page(ctx, title, html`<h1>${title}</h1><p>${message}</p><p><a href="/">Back to ${APP_NAME}</a></p>`);
}

export function mePage(ctx: PageCtx, positions: Position[], ledger: LedgerRow[]): string {
  return page(
    ctx,
    'My bets',
    html`<h1>My bets and ledger</h1>
<p>Balance: <b>${pts(ctx.viewer!.balance)}</b></p>

<h2>Positions</h2>
${positions.length
  ? html`<div class="scroll"><table><thead><tr><th>Market</th><th class="num">YES</th><th class="num">NO</th><th>Status</th><th class="num">Result</th></tr></thead><tbody>
    ${positions.map(
      (p) => html`<tr><td><a href="/markets/${p.public_id}">${p.question}</a></td><td class="num">${p.yes}</td><td class="num">${p.no}</td>
        <td>${p.status === 'resolved' ? p.outcome : p.status}</td><td class="num">${p.status === 'resolved' ? signed(p.net) : '–'}</td></tr>`,
    )}</tbody></table></div>`
  : html`<p class="muted">No bets yet.</p>`}

<h2>Ledger</h2>
<p class="muted">Every change to your balance, newest first.</p>
<div class="scroll"><table><thead><tr><th>When</th><th>What</th><th class="num">Change</th><th class="num">Balance</th></tr></thead><tbody>
${ledger.map(
  (l) => html`<tr><td>${when(l.created_at, true)}</td>
    <td>${LEDGER_LABELS[l.type]}${l.market_public_id ? html`<small><a href="/markets/${l.market_public_id}">${l.question}</a></small>` : ''}</td>
    <td class="num">${signed(l.amount)}</td><td class="num">${l.running.toLocaleString('en-US')}</td></tr>`,
)}</tbody></table></div>

<h2>Change password</h2>
<form method="post" action="/me/password" class="stack narrow">
  <label>Current password <input type="password" name="current" required autocomplete="current-password"></label>
  <label>New password <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
  <button>Change password</button>
</form>`,
  );
}

export function leaderboardPage(ctx: PageCtx, view: 'season' | 'all', seasonLabel: string, rows: LeaderRow[]): string {
  return page(
    ctx,
    'Leaderboard',
    html`<h1>Leaderboard</h1>
<nav class="tabs">
  <a href="/leaderboard" ${view === 'season' ? html`aria-current="page"` : ''}>Season ${seasonLabel}</a>
  <a href="/leaderboard?view=all" ${view === 'all' ? html`aria-current="page"` : ''}>All time</a>
</nav>
<p class="muted">Net points won or lost on resolved markets: stakes, winnings, bonds and juror rewards.
   Weekly allowances don't count. Seasons are calendar quarters (UTC).</p>
<div class="scroll"><table><thead><tr><th>#</th><th>Member</th><th class="num">Net</th><th class="num">Markets</th>${view === 'all' ? html`<th class="num">Balance</th>` : ''}</tr></thead><tbody>
${rows.map(
  (r, i) => html`<tr ${r.id === ctx.viewer?.id ? html`class="you"` : ''}><td>${i + 1}</td><td>${r.name}</td><td class="num">${signed(r.net)}</td>
    <td class="num">${r.markets}</td>${view === 'all' ? html`<td class="num">${r.balance.toLocaleString('en-US')}</td>` : ''}</tr>`,
)}</tbody></table></div>`,
  );
}

export function membersPage(ctx: PageCtx, members: MemberRow[], invites: Invite[], inviteBase: string): string {
  const active = members.filter((m) => m.is_active).length;
  const admin = ctx.viewer!.isAdmin;
  return page(
    ctx,
    'Members',
    html`<h1>Members <small class="muted">${active} / ${MAX_MEMBERS}</small></h1>
<div class="scroll"><table><thead><tr><th>Name</th><th>Joined</th><th>Invited by</th><th>Status</th>${admin ? html`<th></th>` : ''}</tr></thead><tbody>
${members.map(
  (m) => html`<tr><td>${m.display_name}${m.is_owner ? ' (owner)' : m.is_admin ? ' (admin)' : ''}</td><td>${when(m.created_at, true)}</td><td>${m.invited_by_name ?? '–'}</td>
    <td>${m.is_active ? 'Active' : 'Deactivated'}</td>
    ${admin ? html`<td>${memberActions(ctx, m)}</td>` : ''}</tr>`,
)}</tbody></table></div>

<h2>Invite someone</h2>
<p>Invite links work once and expire after 7 days. The new member picks a display name and password and confirms they are 18 or older.</p>
${active >= MAX_MEMBERS
  ? html`<p class="notice">The group is full.</p>`
  : html`<form method="post" action="/invites"><button>Create invite link</button></form>`}
${invites.length
  ? html`<h3>Your unused invites</h3><ul class="invites">${invites.map(
      (i) => html`<li><input readonly value="${inviteBase}/invite/${i.token}" aria-label="Invite link">
        <small>expires ${when(i.expires_at)}</small>
        <form method="post" action="/invites/${i.id}/revoke"><button class="link">Revoke</button></form></li>`,
    )}</ul>`
  : ''}`,
  );
}

/** What the viewer (an admin) can do to `m`: the owner manages admins, other admins only members. */
function memberActions(ctx: PageCtx, m: MemberRow): Html | string {
  const v = ctx.viewer!;
  if (m.id === v.id || m.is_owner) return '';
  const button = (action: string, label: string) =>
    html`<form method="post" action="/members/${m.id}/${action}"><button class="link">${label}</button></form>`;
  const mine = !m.is_admin || v.isOwner; // admins are the owner's to manage
  const active = mine ? button(m.is_active ? 'deactivate' : 'reactivate', m.is_active ? 'Deactivate' : 'Reactivate') : '';
  const reset = mine && m.is_active ? button('reset', 'Reset link') : '';
  const role = !v.isOwner ? '' : m.is_admin ? button('remove-admin', 'Remove admin') : m.is_active ? button('make-admin', 'Make admin') : '';
  return html`${active}${reset}${role}`;
}

export function rulesPage(ctx: PageCtx): string {
  return page(
    ctx,
    'House Rules',
    html`<h1>House Rules</h1>
<section class="notice">
  <p><b>Points are play points. They have no cash value.</b> They cannot be bought, sold, transferred between members,
     redeemed or cashed out, and nothing in ${APP_NAME} will ever offer that.</p>
  <p><b>Real-money side bets are not part of ${APP_NAME}.</b> Don't arrange them here, and don't use markets to track them.</p>
</section>

<h2>Membership</h2>
<ul>
  <li>Invite-only, 18+ only, at most ${MAX_MEMBERS} active members.</li>
  <li>Any member can create a single-use invite link. Admins can deactivate members, delete markets that haven't been resolved, and create password reset links for members (a reset link lets whoever uses it set that member's password). They have no other special powers.</li>
  <li>The owner is an admin who also makes members admins, takes that away, and is the only one who can deactivate an admin
      or make a reset link for one. Nobody can deactivate or demote the owner.</li>
</ul>

<h2>Points</h2>
<ul>
  <li>Every member gets ${WEEKLY_ALLOWANCE.toLocaleString('en-US')} points each Monday at 00:00 UTC, but the allowance never lifts a balance above ${ALLOWANCE_CAP.toLocaleString('en-US')}.</li>
  <li>New members get the current week's allowance when they join.</li>
  <li>Every change to a balance is recorded in your ledger.</li>
</ul>

<h2>Markets</h2>
<ul>
  <li>Any member can create a yes/no market with a clear question, measurable resolution criteria, an evidence source and a trading close time.</li>
  <li>No markets about death, injury, illness, illegal acts or anyone under 18. Creators confirm this with a checklist.</li>
  <li>If a market is about a member, they must opt in before betting opens, and they can never bet on it.</li>
</ul>

<h2>Betting and winnings</h2>
<ul>
  <li>Bets go into a YES pool and a NO pool. The split between them is the implied odds.</li>
  <li>When a market resolves YES or NO, winners get their stake back plus a share of the losing pool in proportion to their stake.
      Shares round down; the few leftover points go one each to the biggest winning stakes.</li>
  <li>If a market resolves VOID, or nobody backed the winning side, every stake is refunded.</li>
</ul>

<h2>Raffle</h2>
<ul>
  <li>A raffle is drawn every 30 seconds. Any member can put points into the current one.</li>
  <li>Each point is a ticket, and one ticket wins the whole pot, so your chance is your share of the pot. Entries are final, and you can add to yours until the round ends.</li>
  <li>If you are the only entrant you get your points back. Raffles do not count towards the leaderboard.</li>
</ul>

<h2>Resolving a market</h2>
<ol>
  <li>After trading closes, any member can propose YES, NO or VOID with an evidence note, posting a bond of 10% of the pool (at least ${MIN_BOND} points).</li>
  <li>For 24 hours anyone else can dispute it by posting an equal bond. Each member can dispute at most ${DISPUTES_PER_WEEK} times a week.</li>
  <li>No dispute: the proposal stands and the proposer's bond comes back.</li>
  <li>Disputed: a random jury of 5 members (3 in groups under 12) with no stake in the market, who aren't its subject, proposer or disputer, votes in secret.
      At least 3 votes and a 2/3 majority decide YES, NO or VOID.</li>
  <li>The side the jury disagreed with loses its bond to the jurors in the majority; the other side gets its bond back.</li>
  <li>No proposal within 7 days of close, or no jury decision within 72 hours: the market is VOID and all stakes and bonds are returned.</li>
</ol>`,
  );
}
