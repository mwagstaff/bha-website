// Builds the subscribable calendar (iCalendar / RFC 5545) of branch events.

import crypto from 'node:crypto';
import { richToText } from './richtext.js';

export const CALENDAR_NAME = 'Beckenham & Bromley HA events';

// How long each kind of event is assumed to last, when it has a start time.
const DURATIONS = { lecture: 'PT1H30M', visit: 'PT2H', social: 'PT2H30M' };

// Europe/London (GMT/BST), so times stay right whatever time zone the reader's device is in.
const LONDON_TIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/London',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0000',
  'TZOFFSETTO:+0100',
  'TZNAME:BST',
  'DTSTART:19700329T010000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0000',
  'TZNAME:GMT',
  'DTSTART:19701025T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

export function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Lines longer than 75 bytes are folded onto continuation lines starting with a space.
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split a character
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines lose one byte to the leading space
  }
  return parts.join('\r\n ');
}

const compactDate = (iso) => iso.replace(/-/g, '');

function nextDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// The first clock time in the event's time ("18:30 for 19:00" starts at 18:30).
function startTime(time) {
  const m = String(time || '').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return m && `${m[1].padStart(2, '0')}${m[2]}00`;
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Stable while the date and title stay the same, so calendars update in place.
function uidFor(event, host) {
  const hash = crypto.createHash('sha1').update(`${event.date}|${event.title}`).digest('hex').slice(0, 16);
  return `${event.date}-${hash}@${host}`;
}

function describe(event, eventsUrl) {
  return [
    event.kicker,
    event.speaker && `Speaker: ${event.speaker}`,
    event.description && richToText(event.description),
    event.note && richToText(event.note),
    `Details: ${eventsUrl}`,
  ].filter(Boolean).join('\n');
}

export function buildCalendar(events, { venue, eventsUrl, host, now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Beckenham & Bromley Historical Association//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(CALENDAR_NAME)}`,
    `X-WR-CALDESC:${escapeText('Talks, visits and social events of the Beckenham and Bromley branch of the Historical Association.')}`,
    'X-WR-TIMEZONE:Europe/London',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
    ...LONDON_TIMEZONE,
  ];

  for (const event of events) {
    const start = startTime(event.time);
    // Lectures are at the usual hall unless stated; visits and outings say where they are.
    const location = event.location || (event.type === 'lecture' ? `${venue.name}, ${venue.postalAddress || venue.address}` : '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uidFor(event, host)}`,
      `DTSTAMP:${utcStamp(now)}`,
      ...(start
        ? [`DTSTART;TZID=Europe/London:${compactDate(event.date)}T${start}`, `DURATION:${DURATIONS[event.type] || 'PT2H'}`]
        : [`DTSTART;VALUE=DATE:${compactDate(event.date)}`, `DTEND;VALUE=DATE:${compactDate(nextDay(event.date))}`]),
      `SUMMARY:${escapeText(event.title)}`,
      `DESCRIPTION:${escapeText(describe(event, eventsUrl))}`,
      ...(location ? [`LOCATION:${escapeText(location)}`] : []),
      `URL:${eventsUrl}`,
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
