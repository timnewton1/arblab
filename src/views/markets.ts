import type { BetListRow, MarketGroup, MarketListRow } from '../domain/markets.ts';
import type { Dispute, Juror, Proposal } from '../domain/resolution.ts';
import { ATTESTATIONS, DISPUTES_PER_WEEK, PROPOSAL_DEADLINE, QUORUM } from '../domain/rules.ts';
import type { MemberRow } from '../domain/users.ts';
import { type Html, html } from '../html.ts';
import { type PageCtx, clock, linkify, marketList, outcomeRadios, page, poolBar, pts, signed, statusLine, until, when, zoneOptions, zonedWhen } from './layout.ts';

const GROUPS: { key: MarketGroup; label: string; empty: string }[] = [
  { key: 'open', label: 'Open', empty: 'No open markets. Start one!' },
  { key: 'awaiting', label: 'Awaiting resolution', empty: 'Nothing waiting on an outcome.' },
  { key: 'resolved', label: 'Resolved', empty: 'Nothing resolved yet.' },
];

export interface TodoItem {
  href: string;
  text: string;
}

export function marketsPage(ctx: PageCtx, group: MarketGroup, rows: MarketListRow[], todo: TodoItem[]): string {
  const current = GROUPS.find((g) => g.key === group)!;
  return page(
    ctx,
    'Markets',
    html`${todo.length
      ? html`<section class="notice"><h2>Needs you</h2><ul>${todo.map((t) => html`<li><a href="${t.href}">${t.text}</a></li>`)}</ul></section>`
      : ''}
<div class="row"><h1>Markets</h1><a class="button" href="/markets/new">New market</a></div>
<p class="muted">Your time: ${clock(ctx.now)}</p>
<nav class="tabs">${GROUPS.map(
      (g) => html`<a href="/?tab=${g.key}" ${g.key === group ? html`aria-current="page"` : ''}>${g.label}</a>`,
    )}</nav>
${marketList(rows, ctx.now, current.empty)}`,
  );
}

export interface NewMarketValues {
  question?: string;
  criteria?: string;
  evidence_source?: string;
  close_local?: string;
  timezone?: string;
  subject_id?: string;
}

export function newMarketPage(ctx: PageCtx, members: MemberRow[], values: NewMarketValues = {}): string {
  return page(
    ctx,
    'New market',
    html`<h1>New market</h1>
<form method="post" action="/markets" class="stack">
  <label>Question
    <input name="question" required minlength="10" maxlength="200" value="${values.question ?? ''}" placeholder="Will … by …?">
  </label>
  <label>Resolution criteria <small>Exactly what makes this YES or NO. It must be measurable.</small>
    <textarea name="criteria" required minlength="10" maxlength="1000" rows="4">${values.criteria ?? ''}</textarea>
  </label>
  <label>Evidence source <small>Where the group will check: a link, a public record, a named person.</small>
    <input name="evidence_source" required minlength="3" maxlength="300" value="${values.evidence_source ?? ''}">
  </label>
  <div class="pair">
    <label>Trading closes <small>No bets after this.</small>
      <input type="datetime-local" name="close_local" required value="${values.close_local ?? ''}">
    </label>
    <label>Time zone <small>Where the event happens. The close time is read in this zone.</small>
      ${timeZoneSelect(ctx.now, values.timezone)}
    </label>
  </div>
  <label>Subject (optional) <small>If the market is about a member, name them. It stays pending until they opt in, and they can never bet on it.</small>
    <select name="subject_id">
      <option value="">Nobody in particular</option>
      ${members
        .filter((m) => m.is_active)
        .map((m) => html`<option value="${m.id}" ${String(m.id) === values.subject_id ? 'selected' : ''}>${m.display_name}</option>`)}
    </select>
  </label>
  <fieldset>
    <legend>Checklist. This market:</legend>
    ${ATTESTATIONS.map(
      (a) => html`<label class="check"><input type="checkbox" name="attest" value="${a.key}" required> ${a.text}</label>`,
    )}
    <small>Your answers are stored with the market.</small>
  </fieldset>
  <button>Create market</button>
</form>`,
  );
}

/** Without a value (a fresh form), app.js preselects the viewer's own zone; without JS it stays on UTC. */
function timeZoneSelect(now: number, value: string | undefined): Html {
  return html`<select name="timezone" required ${value ? '' : html`data-viewer-zone`}>${zoneOptions(now, value || 'UTC')}</select>`;
}

export interface MarketPageData {
  m: MarketListRow;
  bets: BetListRow[];
  my: { yes: number; no: number; ifYes: number; ifNo: number; net: number };
  balance: number;
  bond: number;
  proposal: (Proposal & { name: string }) | undefined;
  dispute: (Dispute & { name: string }) | undefined;
  jurors: (Juror & { name: string })[];
  disputesLeft: number;
  eligibleIfIDispute: number;
  jurySize: number;
  canDelete: boolean;
  deletedBy: string | null;
}

export function marketPage(ctx: PageCtx, d: MarketPageData): string {
  const { m } = d;
  const me = ctx.viewer!.id;
  const isSubject = m.subject_id === me;
  const total = m.yes_pool + m.no_pool;
  return page(
    ctx,
    m.question,
    html`<article class="market">
<p class="muted">Created by ${m.creator_name} ${when(m.created_at)}</p>
${m.deleted_at !== null
  ? html`<p class="notice">${d.deletedBy} deleted this market ${when(m.deleted_at)}. Every stake and bond was returned, and it no longer appears in the lists.</p>`
  : ''}
<h1>${m.question}</h1>
<p>${statusLine(m, ctx.now)}</p>
<dl>
  ${m.subject_name
    ? html`<dt>Subject</dt><dd>${m.subject_name} ${m.subject_opted_in_at ? html`(opted in ${when(m.subject_opted_in_at)})` : '(has not opted in yet)'}</dd>`
    : ''}
  <dt>Resolution criteria</dt><dd class="pre">${m.criteria}</dd>
  <dt>Evidence source</dt><dd>${linkify(m.evidence_source)}</dd>
  <dt>Trading ${m.close_at > ctx.now ? 'closes' : 'closed'}</dt><dd>${zonedWhen(m.close_at, m.timezone, false, m.close_at > ctx.now ? `in ${until(m.close_at, ctx.now)}` : '')}</dd>
  ${m.close_at > ctx.now ? html`<dt>Your time now</dt><dd>${clock(ctx.now)}</dd>` : ''}
</dl>

<section>
  <h2>Pool: ${pts(total)}</h2>
  ${poolBar(m.yes_pool, m.no_pool)}
  ${total > 0 && m.status !== 'resolved'
    ? html`<p class="muted">Implied odds from the pool. 1 point on YES returns ${ratio(total, m.yes_pool)} if YES wins; 1 point on NO returns ${ratio(total, m.no_pool)} if NO wins.</p>`
    : ''}
  ${d.my.yes + d.my.no > 0
    ? html`<p>Your stake: ${pts(d.my.yes)} on YES, ${pts(d.my.no)} on NO.
      ${m.status === 'resolved'
        ? html`Result: <b>${signed(d.my.net)}</b>.`
        : html`At the current pool you get back ${pts(d.my.ifYes)} if YES, ${pts(d.my.ifNo)} if NO, everything if VOID.`}</p>`
    : ''}
</section>

${resolutionSection(ctx, d)}
${actionSection(ctx, d, isSubject)}

<section>
  <h2>Bets</h2>
  ${d.bets.length
    ? html`<table><thead><tr><th>Member</th><th>Side</th><th class="num">Points</th><th>When</th></tr></thead><tbody>
      ${d.bets.map((b) => html`<tr><td>${b.name}</td><td>${b.side}</td><td class="num">${b.amount.toLocaleString('en-US')}</td><td>${when(b.created_at, true)}</td></tr>`)}
      </tbody></table>`
    : html`<p class="muted">No bets yet.</p>`}
</section>

${d.canDelete ? deleteSection(d) : ''}

<details>
  <summary>Creator's checklist</summary>
  <p>${m.creator_name} confirmed at ${when(m.attested_at)} that this market:</p>
  <ul>${(JSON.parse(m.attestation) as string[]).map((t) => html`<li>${t}</li>`)}</ul>
</details>
</article>`,
  );
}

/** Folded away, and the box must be ticked, so a market isn't deleted by a stray click. */
function deleteSection(d: MarketPageData): Html {
  const { m } = d;
  const others = d.bets.length > 0;
  return html`<details class="danger">
  <summary>Delete this market</summary>
  <p>Deleting cancels it for everyone${others ? ': every stake goes back to whoever placed it' : ''}${d.proposal ? ', and any bond still held is returned' : ''}.
     It disappears from the lists. This can't be undone.</p>
  <form method="post" action="/markets/${m.public_id}/delete" class="stack narrow">
    <label class="check"><input type="checkbox" name="confirm" value="yes" required> Yes, delete this market</label>
    <button class="secondary">Delete market</button>
  </form>
</details>`;
}

function ratio(total: number, side: number): string {
  return side === 0 ? 'the whole pool' : `×${(total / side).toFixed(2)}`;
}

function actionSection(ctx: PageCtx, d: MarketPageData, isSubject: boolean): Html | string {
  const { m } = d;
  const me = ctx.viewer!.id;
  switch (m.status) {
    case 'pending':
      return isSubject
        ? html`<section class="notice">
  <h2>This market is about you</h2>
  <p>${m.creator_name} wants to run this market with you as its subject. If you opt in, members can bet on it. You never can.
     If you decline, the market is cancelled. Nobody has bet yet.</p>
  <form method="post" action="/markets/${m.public_id}/subject" class="inline">
    <button name="answer" value="accept">Opt in</button>
    <button name="answer" value="decline" class="secondary">Decline</button>
  </form>
</section>`
        : html`<p class="notice">Betting opens once ${m.subject_name} opts in. If they haven't by the close time, the market is cancelled.</p>`;

    case 'open':
      if (isSubject) return html`<p class="notice">You are the subject of this market, so you cannot bet on it.</p>`;
      return html`<section>
  <h2>Place a bet</h2>
  <form method="post" action="/markets/${m.public_id}/bet" class="stack">
    ${outcomeRadios('side', ['YES', 'NO'])}
    <label>Points <input type="number" name="amount" min="1" max="${d.balance}" step="1" required inputmode="numeric"></label>
    <button>Place bet</button>
    <small>You have ${pts(d.balance)}. Stakes are locked until the market resolves. You can add to your position until close.</small>
  </form>
</section>`;

    case 'closed':
      return html`<section>
  <h2>Propose the outcome</h2>
  <p>Trading has closed. Any member can propose the outcome by posting a bond of <b>${pts(d.bond)}</b>
     (10% of the pool, at least 50). If nobody disputes it within 24 hours, it stands and the bond comes back.
     If nobody proposes by ${when(m.close_at + PROPOSAL_DEADLINE)}, the market is voided and every stake refunded.</p>
  <form method="post" action="/markets/${m.public_id}/propose" class="stack">
    ${outcomeRadios('outcome', ['YES', 'NO', 'VOID'])}
    <label>Evidence note <small>What happened, and where you checked.</small>
      <textarea name="note" required minlength="5" maxlength="1000" rows="3"></textarea></label>
    <button>Post ${pts(d.bond)} bond and propose</button>
  </form>
</section>`;

    case 'proposed': {
      const p = d.proposal!;
      if (p.user_id === me) return '';
      if (d.disputesLeft <= 0) {
        return html`<p class="notice">You have used all ${DISPUTES_PER_WEEK} disputes this week. The count resets Monday 00:00 UTC.</p>`;
      }
      return html`<section>
  <h2>Dispute this proposal</h2>
  <p>Think the proposed outcome is wrong? Post an equal bond of <b>${pts(p.bond)}</b>. A jury of up to ${d.jurySize} members
     with no stake decides. If they agree with the proposal you lose your bond; if not, the proposer loses theirs.
     You have ${d.disputesLeft} of ${DISPUTES_PER_WEEK} disputes left this week.</p>
  ${d.eligibleIfIDispute < QUORUM
    ? html`<p class="flash error">Only ${d.eligibleIfIDispute} member${d.eligibleIfIDispute === 1 ? ' is' : 's are'} free to sit on a jury here,
        so a dispute would void the market and return both bonds.</p>`
    : ''}
  <form method="post" action="/markets/${m.public_id}/dispute" class="stack">
    <label>Why it's wrong <textarea name="note" required minlength="5" maxlength="1000" rows="3"></textarea></label>
    <button>Post ${pts(p.bond)} bond and dispute</button>
  </form>
</section>`;
    }

    case 'disputed': {
      const mine = d.jurors.find((j) => j.user_id === me);
      if (!mine) return '';
      if (mine.vote) return html`<p class="notice">You voted ${mine.vote}. Votes are revealed when voting closes.</p>`;
      return html`<section class="notice">
  <h2>You're on the jury</h2>
  <p>Read the criteria, evidence source and both notes, then vote. Your vote is final and hidden until voting closes.
     At least ${QUORUM} votes and a 2/3 majority decide. Jurors in the majority share the losing bond.</p>
  <form method="post" action="/markets/${m.public_id}/vote" class="stack">
    ${outcomeRadios('vote', ['YES', 'NO', 'VOID'])}
    <button>Cast vote</button>
  </form>
</section>`;
    }

    case 'resolved':
      return '';
  }
}

function resolutionSection(ctx: PageCtx, d: MarketPageData): Html | string {
  const { m, proposal: p, dispute: x } = d;
  if (!p && m.status !== 'resolved') return '';
  const votingClosed = x?.closed_at != null;
  return html`<section>
  <h2>Resolution</h2>
  ${m.status === 'resolved' ? html`<p><b>Outcome: ${m.outcome}.</b> ${m.resolution_note} ${when(m.resolved_at!)}</p>` : ''}
  ${p
    ? html`<p>${p.name} proposed <b>${p.outcome}</b> ${when(p.created_at)} with a ${pts(p.bond)} bond:</p>
      <blockquote class="pre">${p.note}</blockquote>
      ${m.status === 'proposed' ? html`<p>Challenge window closes ${when(p.challenge_ends_at)} (${until(p.challenge_ends_at, ctx.now)} left).</p>` : ''}`
    : ''}
  ${x
    ? html`<p>${x.name} disputed it ${when(x.created_at)} with a ${pts(x.bond)} bond:</p>
      <blockquote class="pre">${x.note}</blockquote>
      ${votingClosed
        ? html`<p>Jury votes:</p><ul>${d.jurors.map((j) => html`<li>${j.name}: ${j.vote ?? 'did not vote'}</li>`)}</ul>`
        : html`<p>${d.jurors.filter((j) => j.vote).length} of ${d.jurors.length} jurors have voted. Voting closes when all have voted
            or at ${when(x.voting_ends_at)}, whichever is first; with no decision by then the market is voided.
            Jurors and votes stay hidden until then.</p>`}`
    : ''}
</section>`;
}
