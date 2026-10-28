// Progressive enhancement only: every page works without this file.

// Show times in the viewer's time zone (the server renders UTC). The zone is the device's own unless
// they pick another in the footer; the choice is kept per browser. A market time shows the viewer's time
// in bold, with the event's own time (data-zone) underneath when it reads differently.
const TZ_KEY = 'arblab-tz';
const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function validZone(z) {
  try {
    return Boolean(z) && Boolean(new Intl.DateTimeFormat('en', { timeZone: z }));
  } catch {
    return false;
  }
}
function savedZone() {
  try {
    const z = localStorage.getItem(TZ_KEY);
    return validZone(z) ? z : '';
  } catch {
    return '';
  }
}
let zone = savedZone() || deviceZone;

const long = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
const short = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
function format(d, el) {
  let opts = el.hasAttribute('data-short') ? short : long;
  if (el.hasAttribute('data-seconds') || el.hasAttribute('data-clock')) opts = { ...opts, second: '2-digit' };
  // The event's time is followed by its zone's name; the viewer's time beside it needs its zone shown, even when short.
  if (el.dataset.zone) opts = { ...opts, timeZoneName: undefined };
  else if (el.closest('[data-zoned]')) opts = { ...opts, timeZoneName: 'short' };
  return d.toLocaleString(undefined, { ...opts, timeZone: el.dataset.zone || zone });
}
// Whether two zones show the same date and time at instant `d`.
function sameWallClock(d, a, b) {
  const f = (tz) => d.toLocaleString('en-US', { timeZone: tz, hourCycle: 'h23' });
  return f(a) === f(b);
}
function localTimes(root) {
  for (const el of root.querySelectorAll('time[datetime]')) {
    const d = new Date(el.getAttribute('datetime'));
    if (Number.isNaN(d.getTime())) continue;
    el.dataset.utc ??= el.textContent;
    if (!el.closest('[data-zoned]')) el.title = el.dataset.utc;
    el.textContent = format(d, el);
  }
  for (const el of root.querySelectorAll('[data-zoned]')) {
    const event = el.querySelector('time[data-zone]');
    el.querySelector('[data-event-time]').hidden = sameWallClock(new Date(event.getAttribute('datetime')), event.dataset.zone, zone);
  }
}
localTimes(document);

// Live clocks start from the server's time and advance with this device's clock.
const clocks = document.querySelectorAll('time[data-clock]');
if (clocks.length) {
  const offset = new Date(clocks[0].getAttribute('datetime')).getTime() - Date.now();
  setInterval(() => {
    const d = new Date(Date.now() + offset);
    for (const el of clocks) {
      el.setAttribute('datetime', d.toISOString());
      el.textContent = format(d, el);
    }
  }, 1000);
}

// A zone's UTC offsets, week by week over the coming year: zones with the same pattern keep the same clock.
const rulesCache = new Map();
function zoneRules(z) {
  if (!rulesCache.has(z)) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'longOffset' });
    const week = 7 * 24 * 3600 * 1000;
    const start = Date.now();
    const offsets = [];
    for (let t = start; t < start + 53 * week; t += week) offsets.push(f.formatToParts(t).find((p) => p.type === 'timeZoneName').value);
    rulesCache.set(z, offsets.join());
  }
  return rulesCache.get(z);
}

// The picker lists one zone per set of clock rules (Europe/Paris stands for Amsterdam too): find the entry for `z`.
function zoneOption(select, z) {
  const options = [...select.options].filter((o) => o.value);
  return options.find((o) => o.value === z) ?? options.find((o) => zoneRules(o.value) === zoneRules(z));
}

// A new market's zone starts as the viewer's own, until they pick one.
const marketZone = document.querySelector('select[data-viewer-zone]');
function presetMarketZone() {
  const o = marketZone && zoneOption(marketZone, zone);
  if (o) marketZone.value = o.value;
}
presetMarketZone();
marketZone?.addEventListener('change', () => marketZone.removeAttribute('data-viewer-zone'));

// Time zone picker in the footer: "Automatic" follows the device, anything else is remembered.
const tzSelect = document.getElementById('tz');
if (tzSelect) {
  const auto = zoneOption(tzSelect, deviceZone);
  tzSelect.options[0].text = `Automatic: ${auto ? auto.text : deviceZone.replaceAll('_', ' ')}`;
  const saved = savedZone();
  tzSelect.value = saved ? (zoneOption(tzSelect, saved)?.value ?? '') : '';
  tzSelect.addEventListener('change', () => {
    try {
      if (tzSelect.value) localStorage.setItem(TZ_KEY, tzSelect.value);
      else localStorage.removeItem(TZ_KEY);
    } catch {
      // storage blocked: the choice lasts until the page is left
    }
    zone = tzSelect.value || deviceZone;
    localTimes(document);
    if (marketZone?.hasAttribute('data-viewer-zone')) presetMarketZone();
  });
  tzSelect.closest('label').hidden = false;
}

// Select an invite link on focus so it is easy to copy.
for (const input of document.querySelectorAll('.invites input')) {
  input.addEventListener('focus', () => input.select());
}

// Keep the raffle page live: poll for entrants, pot, draws and balance, and tick the countdown between polls.
// The form is outside the swapped parts, so a half-typed entry survives. The countdown runs from page load
// rather than the server's clock, so a wrong clock on this device doesn't matter.
if (document.querySelector('[data-raffle-live]')) {
  const byId = (id) => document.getElementById(id);
  let end = 0;
  let fetching = false;
  let lastPoll = 0;

  async function poll() {
    if (fetching) return;
    fetching = true;
    lastPoll = Date.now();
    try {
      const res = await fetch('/raffle/state', { credentials: 'same-origin', cache: 'no-store' });
      if (res.redirected || !res.ok) return location.reload(); // logged out, or the server is unhappy
      const s = await res.json();
      end = Date.now() + s.left;
      byId('raffle-status').innerHTML = s.status;
      byId('raffle-entrants').innerHTML = s.entrants;
      byId('raffle-draws').innerHTML = s.draws;
      byId('raffle-balance').textContent = s.balanceText;
      const balance = byId('balance');
      if (balance) balance.textContent = s.balanceText;
      document.querySelector('[data-raffle-live] input[name=amount]').max = s.balance;
      localTimes(byId('raffle-draws'));
    } catch {
      // offline or a blip: the next poll tries again
    } finally {
      fetching = false;
    }
  }

  setInterval(() => {
    const countdown = byId('countdown');
    if (!end || !countdown) return;
    const left = end - Date.now();
    countdown.textContent = `${Math.max(0, Math.ceil(left / 1000))}s`;
    // Just after the draw, ask again every second until the new round shows up.
    if (left <= 0 && Date.now() - lastPoll >= 1000) poll();
  }, 250);
  setInterval(poll, 3000);
  poll();
}
