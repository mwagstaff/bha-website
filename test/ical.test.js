import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendar, escapeText, foldLine } from '../lib/ical.js';

const venue = { name: 'Christ Church Hall', address: 'Fairfield Road, Beckenham BR3 3LE' };
const opts = { venue, host: 'bha.example', eventsUrl: 'https://bha.example/events', now: new Date('2026-10-21T12:00:00Z') };

// Unfolds lines and splits the calendar into its events.
function parse(ics) {
  const lines = ics.replace(/\r\n /g, '').split('\r\n');
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = {};
    else if (line === 'END:VEVENT') { events.push(current); current = null; } else if (current) {
      const i = line.indexOf(':');
      current[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  return { lines, events };
}

test('escapes commas, semicolons, backslashes and new lines', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
});

test('folds long lines at 75 bytes without splitting a character', () => {
  const line = `SUMMARY:${'Eugénie de Montijo — '.repeat(10)}`;
  const folded = foldLine(line);
  for (const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part) <= 75, part);
  assert.equal(folded.replace(/\r\n /g, ''), line);
  assert.equal(foldLine('SHORT:line'), 'SHORT:line');
});

test('builds a valid calendar with London times', () => {
  const ics = buildCalendar([
    { date: '2026-10-22', time: '19:30', type: 'lecture', title: 'Bedding the Monarch', speaker: 'Dr. Gabrielle Storey' },
  ], opts);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every line ends with CRLF');
  const { lines, events } = parse(ics);
  assert.ok(lines.includes('TZID:Europe/London'));
  assert.ok(lines.includes('X-WR-CALNAME:Beckenham & Bromley HA events'));
  const [e] = events;
  assert.equal(e['DTSTART;TZID=Europe/London'], '20261022T193000');
  assert.equal(e.DURATION, 'PT1H30M');
  assert.equal(e.SUMMARY, 'Bedding the Monarch');
  assert.match(e.DESCRIPTION, /Speaker: Dr. Gabrielle Storey/);
  assert.equal(e.LOCATION, 'Christ Church Hall\\, Fairfield Road\\, Beckenham BR3 3LE');
  assert.equal(e.DTSTAMP, '20261021T120000Z');
});

test('events without a clear time are all-day; "18:30 for 19:00" starts at 18:30', () => {
  const { events } = parse(buildCalendar([
    { date: '2027-04-29', time: '18:30 for 19:00', type: 'social', title: 'Annual Dinner', location: 'Lugana Restaurant, Beckenham' },
    { date: '2027-12-31', type: 'visit', title: 'No time given' },
  ], opts));
  assert.equal(events[0]['DTSTART;TZID=Europe/London'], '20270429T183000');
  assert.equal(events[0].DURATION, 'PT2H30M');
  assert.equal(events[0].LOCATION, 'Lugana Restaurant\\, Beckenham');
  assert.equal(events[1]['DTSTART;VALUE=DATE'], '20271231');
  assert.equal(events[1]['DTEND;VALUE=DATE'], '20280101', 'all-day events end the next day, across a year end');
  assert.equal(events[1].LOCATION, undefined, "visits don't default to the lecture hall");
});

test('event IDs stay the same between builds, and differ between events', () => {
  const ev = [{ date: '2026-11-19', time: '19:30', type: 'lecture', title: 'Beckenham and Penge in the General Strike' },
    { date: '2026-11-24', time: '11:30', type: 'visit', title: 'Guided visit to the Mansion House' }];
  const a = parse(buildCalendar(ev, opts)).events.map((e) => e.UID);
  const b = parse(buildCalendar(ev, { ...opts, now: new Date() })).events.map((e) => e.UID);
  assert.deepEqual(a, b);
  assert.notEqual(a[0], a[1]);
  assert.match(a[0], /@bha\.example$/);
});

test('an empty programme is still a valid calendar', () => {
  const { lines, events } = parse(buildCalendar([], opts));
  assert.equal(events.length, 0);
  assert.equal(lines.at(-2), 'END:VCALENDAR');
});
