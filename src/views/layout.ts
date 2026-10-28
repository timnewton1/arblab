import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MarketListRow } from '../domain/markets.ts';
import { impliedYes } from '../domain/payout.ts';
import { type Html, html } from '../html.ts';
import { formatDuration, formatInZone, formatUtc, timeZoneOptions, zoneName } from '../time.ts';

export const APP_NAME = 'Arblab';

// Static files are cached for an hour, so their URLs carry a hash of the content: an edit gets fetched at once.
const assetUrl = (file: string): string => {
  const body = readFileSync(new URL(`../../public/${file}`, import.meta.url));
  return `/static/${file}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`;
};
const STYLE_URL = assetUrl('style.css');
const SCRIPT_URL = assetUrl('app.js');

export interface Viewer {
  id: number;
  name: string;
  isAdmin: boolean;
  isOwner: boolean;
  balance: number;
}

export interface Flash {
  kind: 'ok' | 'error';
  message: string;
}

export interface PageCtx {
  viewer: Viewer | null;
  flash: Flash | null;
  now: number;
}

export function page(ctx: PageCtx, title: string, body: Html): string {
  const v = ctx.viewer;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${APP_NAME}</title>
<link rel="stylesheet" href="${STYLE_URL}">
<script src="${SCRIPT_URL}" defer></script>
</head>
<body>
<header>
  <a class="brand" href="/">${APP_NAME}</a>
  ${v
    ? html`<nav>
    <a href="/">Markets</a>
    <a href="/markets/new">New market</a>
    <a href="/raffle">Raffle</a>
    <a href="/me">My bets</a>
    <a href="/leaderboard">Leaderboard</a>
    <a href="/members">Members</a>
    <a href="/rules">Rules</a>
  </nav>
  <div class="me">
    <span id="balance" title="Play points. No cash value.">${pts(v.balance)}</span>
    <form method="post" action="/logout"><button class="link">Log out ${v.name}</button></form>
  </div>`
    : html`<nav><a href="/login">Log in</a> <a href="/rules">Rules</a></nav>`}
</header>
<main>
${ctx.flash ? html`<p class="flash ${ctx.flash.kind}" role="status">${ctx.flash.message}</p>` : ''}
${body}
</main>
<footer>
<label class="tz" hidden>Show times in <select id="tz"><option value="">Automatic</option>${zoneOptions(ctx.now)}</select></label>
Play points only. They have no cash value and cannot be bought, sold, transferred or redeemed. <a href="/rules">House Rules</a></footer>
</body>
</html>`.value;
}

export function pts(n: number): string {
  return `${n.toLocaleString('en-US')} pts`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US');
}

/** A timestamp; app.js rewrites it in the viewer's time zone (`short` drops the year, for tables). */
export function when(t: number, short = false): Html {
  return html`<time datetime="${new Date(t).toISOString()}" ${short ? html`data-short` : ''}>${formatUtc(t)}</time>`;
}

/** The time zone picker's options, west to east; app.js picks the viewer's own where nothing is `selected`. */
export function zoneOptions(now: number, selected = ''): Html[] {
  return timeZoneOptions(now).map((o) => html`<option value="${o.zone}" ${o.zone === selected ? 'selected' : ''}>${o.label}</option>`);
}

/**
 * A market time: the viewer's own time first, in bold, and underneath it the time where the event is, when
 * that reads differently (app.js fills in the first and decides the second; without it the first shows the
 * event's time). Markets from before time zones fall back to `when`. `note` follows the viewer's time.
 */
export function zonedWhen(t: number, zone: string | null, short = false, note = ''): Html {
  const after = note ? html` <span class="muted">· ${note}</span>` : '';
  if (!zone) return html`${when(t, short)}${after}`;
  const iso = new Date(t).toISOString();
  const s = short ? html`data-short` : '';
  return html`<span class="zoned" data-zoned><time class="yours" datetime="${iso}" ${s}>${formatInZone(t, zone, short)}</time>${after}<span class="event-time" data-event-time hidden>${short ? ' · ' : html`<br>`}<time datetime="${iso}" data-zone="${zone}" ${s}>${formatInZone(t, zone, short, false)}</time> ${zoneName(zone)}</span></span>`;
}

/** The viewer's current time; app.js keeps it ticking in their chosen time zone. */
export function clock(now: number): Html {
  return html`<time datetime="${new Date(now).toISOString()}" data-clock>${formatUtc(now)}</time>`;
}

export function until(t: number, now: number): string {
  return formatDuration(t - now);
}

/** Shows a link only for http(s) URLs; everything else is plain text. */
export function linkify(text: string): Html {
  return /^https?:\/\/\S+$/i.test(text)
    ? html`<a href="${text}" rel="noopener noreferrer nofollow" target="_blank">${text}</a>`
    : html`${text}`;
}

export function statusLine(m: MarketListRow, now: number): Html {
  switch (m.status) {
    case 'pending':
      return html`<span class="tag">Waiting for ${m.subject_name} to opt in</span>`;
    case 'open':
      return html`<span class="tag open">Open</span> closes in ${until(m.close_at, now)}`;
    case 'closed':
      return html`<span class="tag wait">Closed</span> awaiting a proposed outcome`;
    case 'proposed':
      return html`<span class="tag wait">Outcome proposed</span> challenge window open`;
    case 'disputed':
      return html`<span class="tag wait">Disputed</span> jury voting`;
    case 'resolved':
      if (m.deleted_at !== null) return html`<span class="tag">Deleted</span>`;
      return html`<span class="tag ${m.outcome?.toLowerCase()}">Resolved ${m.outcome}</span>`;
  }
}

export function poolBar(yes: number, no: number): Html {
  const p = impliedYes(yes, no);
  if (p === null) return html`<p class="muted">No bets yet.</p>`;
  return html`<div class="pool">
  <div class="bar" role="img" aria-label="YES ${p}%, NO ${100 - p}%"><span style="width:${p}%"></span></div>
  <div class="split"><span>YES ${p}% · ${pts(yes)}</span><span>NO ${100 - p}% · ${pts(no)}</span></div>
</div>`;
}

export function marketList(rows: MarketListRow[], now: number, empty: string): Html {
  if (rows.length === 0) return html`<p class="muted">${empty}</p>`;
  return html`<ul class="markets">${rows.map(
    (m) => html`<li>
  <a href="/markets/${m.public_id}">${m.question}</a>
  <div class="meta">${statusLine(m, now)}${m.status === 'open' || m.status === 'pending' ? html` (${zonedWhen(m.close_at, m.timezone, true)})` : ''}${m.subject_name ? html` · about ${m.subject_name}` : ''} · pool ${pts(m.yes_pool + m.no_pool)}</div>
  ${m.status === 'resolved' ? '' : poolBar(m.yes_pool, m.no_pool)}
</li>`,
  )}</ul>`;
}

export function outcomeRadios(name: string, options: readonly string[]): Html {
  return html`<div class="choices">${options.map(
    (o) => html`<label class="choice"><input type="radio" name="${name}" value="${o}" required> ${o}</label>`,
  )}</div>`;
}
