export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Monday 00:00 UTC of the week containing `t`. */
export function weekStart(t: number): number {
  const d = new Date(t);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
}

/** Seasons are calendar quarters (UTC). */
export function seasonOf(t: number): { start: number; end: number; label: string } {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3);
  return { start: Date.UTC(y, q * 3, 1), end: Date.UTC(y, q * 3 + 3, 1), label: `${y} Q${q + 1}` };
}

/** "2026-10-27 18:00 UTC" — app.js swaps this for the viewer's local time. */
export function formatUtc(t: number): string {
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/**
 * The zones a market (or the footer picker) can use: one entry per set of clock rules, so places that always
 * agree share an entry. `zone` is the IANA zone that does the arithmetic; the cities are what people look for.
 */
export const TIME_ZONES: readonly { zone: string; name: string; cities: string[] }[] = [
  { zone: 'Pacific/Pago_Pago', name: 'Samoa Time', cities: ['Pago Pago', 'Midway'] },
  { zone: 'Pacific/Honolulu', name: 'Hawaii Time', cities: ['Honolulu'] },
  { zone: 'America/Anchorage', name: 'Alaska Time', cities: ['Anchorage', 'Juneau'] },
  { zone: 'America/Los_Angeles', name: 'Pacific Time', cities: ['Los Angeles', 'San Francisco', 'Seattle', 'Vancouver', 'Tijuana'] },
  { zone: 'America/Denver', name: 'Mountain Time', cities: ['Denver', 'Salt Lake City', 'Calgary', 'Edmonton'] },
  { zone: 'America/Phoenix', name: 'Arizona Time', cities: ['Phoenix', 'Tucson', 'Hermosillo'] },
  { zone: 'America/Chicago', name: 'Central Time', cities: ['Chicago', 'Houston', 'Dallas', 'Winnipeg'] },
  { zone: 'America/Mexico_City', name: 'Mexico & Central America Time', cities: ['Mexico City', 'Guadalajara', 'Guatemala City', 'San José', 'Regina'] },
  { zone: 'America/New_York', name: 'Eastern Time', cities: ['New York', 'Toronto', 'Miami', 'Atlanta'] },
  { zone: 'America/Bogota', name: 'Colombia & Peru Time', cities: ['Bogotá', 'Lima', 'Quito', 'Panama City', 'Cancún'] },
  { zone: 'America/Halifax', name: 'Atlantic Time', cities: ['Halifax', 'Bermuda'] },
  { zone: 'America/Caracas', name: 'Venezuela & Caribbean Time', cities: ['Caracas', 'La Paz', 'Manaus', 'San Juan', 'Santo Domingo'] },
  { zone: 'America/Santiago', name: 'Chile Time', cities: ['Santiago'] },
  { zone: 'America/St_Johns', name: 'Newfoundland Time', cities: ["St. John's"] },
  { zone: 'America/Sao_Paulo', name: 'Brazil & Argentina Time', cities: ['São Paulo', 'Rio de Janeiro', 'Buenos Aires', 'Montevideo'] },
  { zone: 'America/Nuuk', name: 'Greenland Time', cities: ['Nuuk'] },
  { zone: 'Atlantic/Azores', name: 'Azores Time', cities: ['Ponta Delgada'] },
  { zone: 'Atlantic/Cape_Verde', name: 'Cape Verde Time', cities: ['Praia'] },
  { zone: 'UTC', name: 'Coordinated Universal Time', cities: ['Reykjavík', 'Accra', 'Dakar'] },
  { zone: 'Europe/London', name: 'UK, Ireland & Portugal Time', cities: ['London', 'Dublin', 'Lisbon', 'Edinburgh'] },
  { zone: 'Europe/Paris', name: 'Central European Time', cities: ['Berlin', 'Paris', 'Madrid', 'Rome', 'Amsterdam', 'Warsaw'] },
  { zone: 'Africa/Lagos', name: 'West Africa Time', cities: ['Lagos', 'Kinshasa', 'Algiers', 'Tunis'] },
  { zone: 'Africa/Casablanca', name: 'Morocco Time', cities: ['Casablanca', 'Rabat'] },
  { zone: 'Europe/Athens', name: 'Eastern European Time', cities: ['Athens', 'Helsinki', 'Kyiv', 'Bucharest', 'Sofia'] },
  { zone: 'Africa/Johannesburg', name: 'South & Central Africa Time', cities: ['Johannesburg', 'Cape Town', 'Harare', 'Maputo', 'Kaliningrad'] },
  { zone: 'Africa/Cairo', name: 'Egypt Time', cities: ['Cairo'] },
  { zone: 'Asia/Jerusalem', name: 'Israel Time', cities: ['Jerusalem', 'Tel Aviv'] },
  { zone: 'Europe/Moscow', name: 'Moscow & Arabia Time', cities: ['Moscow', 'Istanbul', 'Riyadh', 'Nairobi', 'Baghdad'] },
  { zone: 'Asia/Tehran', name: 'Iran Time', cities: ['Tehran'] },
  { zone: 'Asia/Dubai', name: 'Gulf Time', cities: ['Dubai', 'Abu Dhabi', 'Muscat', 'Baku', 'Tbilisi'] },
  { zone: 'Asia/Kabul', name: 'Afghanistan Time', cities: ['Kabul'] },
  { zone: 'Asia/Karachi', name: 'Pakistan Time', cities: ['Karachi', 'Lahore', 'Tashkent', 'Yekaterinburg'] },
  { zone: 'Asia/Kolkata', name: 'India Time', cities: ['Mumbai', 'Delhi', 'Kolkata', 'Colombo'] },
  { zone: 'Asia/Kathmandu', name: 'Nepal Time', cities: ['Kathmandu'] },
  { zone: 'Asia/Dhaka', name: 'Bangladesh Time', cities: ['Dhaka', 'Thimphu', 'Bishkek', 'Omsk'] },
  { zone: 'Asia/Yangon', name: 'Myanmar Time', cities: ['Yangon'] },
  { zone: 'Asia/Bangkok', name: 'Indochina Time', cities: ['Bangkok', 'Jakarta', 'Ho Chi Minh City', 'Hanoi', 'Novosibirsk'] },
  { zone: 'Asia/Shanghai', name: 'China & Singapore Time', cities: ['Beijing', 'Hong Kong', 'Singapore', 'Taipei', 'Manila', 'Perth'] },
  { zone: 'Asia/Tokyo', name: 'Japan & Korea Time', cities: ['Tokyo', 'Osaka', 'Seoul'] },
  { zone: 'Australia/Darwin', name: 'Northern Australia Time', cities: ['Darwin'] },
  { zone: 'Australia/Adelaide', name: 'South Australia Time', cities: ['Adelaide', 'Broken Hill'] },
  { zone: 'Australia/Brisbane', name: 'Queensland & West Pacific Time', cities: ['Brisbane', 'Guam', 'Port Moresby', 'Vladivostok'] },
  { zone: 'Australia/Sydney', name: 'Southeast Australia Time', cities: ['Sydney', 'Melbourne', 'Canberra', 'Hobart'] },
  { zone: 'Pacific/Noumea', name: 'Solomon Islands & New Caledonia Time', cities: ['Nouméa', 'Honiara', 'Magadan'] },
  { zone: 'Pacific/Auckland', name: 'New Zealand Time', cities: ['Auckland', 'Wellington'] },
  { zone: 'Pacific/Fiji', name: 'Fiji Time', cities: ['Suva', 'Majuro', 'Petropavlovsk-Kamchatsky'] },
  { zone: 'Pacific/Tongatapu', name: 'Tonga & Samoa Time', cities: ["Nukuʻalofa", 'Apia'] },
  { zone: 'Pacific/Kiritimati', name: 'Line Islands Time', cities: ['Kiritimati'] },
];

const BY_ZONE = new Map(TIME_ZONES.map((z) => [z.zone, z]));

export function isTimeZone(zone: string): boolean {
  return BY_ZONE.has(zone);
}

/** How far `zone` is ahead of UTC at instant `t`, in ms. */
function zoneOffset(t: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(t);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/**
 * The instant a datetime-local value ("2026-10-30T17:00") means as a wall-clock time in `zone`, or NaN.
 * The second pass corrects for a DST change between the guess and the answer.
 */
export function wallTimeToEpoch(value: string, zone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value) || !isTimeZone(zone)) return NaN;
  const asUtc = Date.parse(`${value}Z`);
  if (Number.isNaN(asUtc)) return NaN;
  const guess = asUtc - zoneOffset(asUtc, zone);
  return asUtc - zoneOffset(guess, zone);
}

/** "Oct 30, 2026, 5:00 PM" (plus "GMT+9" with `withZone`) in `zone`; app.js reformats it in the viewer's locale. */
export function formatInZone(t: number, zone: string, short = false, withZone = true): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: short ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: withZone ? 'short' : undefined,
  }).format(t);
}

/** "Central European Time" for a listed zone; "Buenos Aires time" for any other (markets from older pickers). */
export function zoneName(zone: string): string {
  const listed = BY_ZONE.get(zone);
  if (listed) return listed.name;
  const place = zone.replaceAll('_', ' ').split('/').at(-1)!;
  return place === 'UTC' ? 'UTC' : `${place} time`;
}

/** "UTC+09:00", "UTC−03:30" or "UTC+00:00": the zone's offset at instant `t`. */
function offsetLabel(zone: string, t: number): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(t)
    .find((p) => p.type === 'timeZoneName')!.value;
  return name === 'GMT' ? 'UTC+00:00' : name.replace('GMT', 'UTC').replace('-', '−');
}

let optionsCache: { hour: number; options: { zone: string; label: string }[] } | undefined;

/**
 * Picker entries, west to east by their offset at `t`: "UTC+01:00 Central European Time (Berlin, Paris, …)".
 * Every page's footer shows them, so they're worked out once an hour (DST changes fall on the hour).
 */
export function timeZoneOptions(t: number): { zone: string; label: string }[] {
  const hour = Math.floor(t / HOUR);
  if (optionsCache?.hour !== hour) optionsCache = { hour, options: buildOptions(t) };
  return optionsCache.options;
}

function buildOptions(t: number): { zone: string; label: string }[] {
  return TIME_ZONES.map((z) => ({ z, offset: zoneOffset(t, z.zone) }))
    .sort((a, b) => a.offset - b.offset)
    .map(({ z }) => ({ zone: z.zone, label: `${offsetLabel(z.zone, t)} ${z.name} (${z.cities.join(', ')})` }));
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / HOUR);
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  if (h >= 1) return `${h}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
  return `${Math.max(1, Math.floor(ms / MINUTE))}m`;
}
