import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEvents, parseDate, tidyTime, createEventsStore } from '../lib/events.js';

test('reads British dates in lots of formats', () => {
  for (const s of ['22/10/2026', '22/10/26', '22-10-2026', '22.10.2026', '22 10 2026', '2026-10-22',
    '22 October 2026', '22nd Oct 2026', 'Thursday 22nd October 2026', 'Thurs, 22 Oct 2026', 'October 22 2026', '22-Oct-26']) {
    assert.equal(parseDate(s), '2026-10-22', s);
  }
  for (const s of ['31/02/2027', '22/13/2026', 'next Thursday', '22 October', 'Octember 22 2026']) {
    assert.equal(parseDate(s), null, s);
  }
});

test('tidies times, and shows anything unusual as typed', () => {
  assert.equal(tidyTime('7.30pm'), '19:30');
  assert.equal(tidyTime('7:30 p.m.'), '19:30');
  assert.equal(tidyTime('7pm'), '19:00');
  assert.equal(tidyTime('19.30'), '19:30');
  assert.equal(tidyTime('1930'), '19:30');
  assert.equal(tidyTime('12am'), '00:00');
  assert.equal(tidyTime('18:30 for 19:00'), '18:30 for 19:00');
  assert.equal(tidyTime('7'), '7');
});

test('a broken entry is skipped but everything else still shows', () => {
  const { events, problems } = parseEvents(`
# a comment
Date: 22/10/2026
Title: Good one

Date: 31/02/2027
Title: Impossible date

Title: No date at all

Date: 19/11/2026
Speaker: Only a speaker

this line is just random text

DATE : 03/12/2026
titel: Misspelt label
Note: Pre-booking essential
`);
  assert.deepEqual(events.map((e) => e.date), ['2026-10-22', '2026-11-19', '2026-12-03']);
  assert.equal(events[1].title, 'Only a speaker');
  assert.equal(events[2].title, 'Misspelt label');
  assert.equal(events[2].note, 'Pre-booking essential');
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /31\/02\/2027/);
  assert.match(problems.join('\n'), /no "Date:"/);
  assert.match(problems.join('\n'), /random text/);
});

test('an unknown label straight after the date is reported, not swallowed into the date', () => {
  const { events, problems } = parseEvents('Date: 1/1/27\nRoom: Upstairs\nTitle: Talk');
  assert.equal(events[0].date, '2027-01-01');
  assert.match(problems[0], /Room/);
});

test('long text that happens to contain a colon still runs on', () => {
  const { events, problems } = parseEvents('Date: 20/5/27\nTitle: Elizabeth Barton\nThe Nun: opposition to Henry VIII');
  assert.equal(events[0].title, 'Elizabeth Barton The Nun: opposition to Henry VIII');
  assert.equal(problems.length, 0);
});

test('copes with case, spacing, missing colons, wrapped lines and labels it knows by other names', () => {
  const { events, problems } = parseEvents(`
  when -   7 May 2027
  TIME= 9am
  title:A stroll
  round Dulwich village
  Where: Dulwich
  booking: Pre-booking essential
`);
  assert.equal(problems.length, 0);
  assert.deepEqual(events[0], {
    date: '2027-05-07', time: '09:00', title: 'A stroll round Dulwich village',
    location: 'Dulwich', note: 'Pre-booking essential', type: 'visit',
  });
});

test('two events run together without a blank line are still both shown', () => {
  const { events } = parseEvents(`Date: 01/01/2027
Title: First
Date: 02/01/2027
Title: Second`);
  assert.deepEqual(events.map((e) => e.title), ['First', 'Second']);
});

test('guesses the type when missing, and warns when it is unrecognised', () => {
  const { events, problems } = parseEvents(`Date: 1/1/27
Title: Annual Dinner

Date: 2/1/27
Title: Guided visit to the Foundling Museum

Date: 3/1/27
Type: Seminar
Title: The People of 1381`);
  assert.deepEqual(events.map((e) => e.type), ['social', 'visit', 'lecture']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Seminar/);
});

test('sorts events into date order', () => {
  const { events } = parseEvents('Date: 3/3/27\nTitle: C\n\nDate: 1/1/27\nTitle: A\n\nDate: 2/2/27\nTitle: B');
  assert.deepEqual(events.map((e) => e.title), ['A', 'B', 'C']);
});

test('an empty or garbage file gives no events rather than an error', () => {
  assert.deepEqual(parseEvents('').events, []);
  assert.deepEqual(parseEvents('\u0000\u0001 {{{ ]]] ::: ').events, []);
});

test('the store picks up edits and keeps the last good programme if the file disappears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bha-events-'));
  const file = path.join(dir, 'events.txt');
  fs.writeFileSync(file, 'Date: 1/1/27\nTitle: First');
  const load = createEventsStore(file);
  assert.equal(load().events.length, 1);

  fs.writeFileSync(file, 'Date: 1/1/27\nTitle: First\n\nDate: 2/1/27\nTitle: Second');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(load().events.length, 2);

  fs.rmSync(file);
  const fallback = load();
  assert.equal(fallback.events.length, 2);
  assert.match(fallback.problems.at(-1), /couldn't be read/);
  fs.rmSync(dir, { recursive: true });
});

test('the real events file is fully understood', () => {
  const text = fs.readFileSync(new URL('../content/events.txt', import.meta.url), 'utf8');
  const { events, problems } = parseEvents(text);
  assert.deepEqual(problems, []);
  assert.ok(events.length > 0);
});

test('a forgotten colon after Date or Time is fine, but ordinary sentences are left alone', () => {
  const { events, problems } = parseEvents('Date 26/11/2026\nTime 7.30pm\nTitle: Talk\nDescription: We meet at seven.\nWhen we arrive there will be tea.');
  assert.equal(problems.length, 0);
  assert.equal(events[0].date, '2026-11-26');
  assert.equal(events[0].time, '19:30');
  assert.equal(events[0].description, 'We meet at seven. When we arrive there will be tea.');
});

test('text -> cards -> text keeps the real programme exactly', async () => {
  const { parseToItems, itemsToText } = await import('../lib/events.js');
  const text = fs.readFileSync(new URL('../content/events.txt', import.meta.url), 'utf8');
  const again = itemsToText(parseToItems(text));
  assert.deepEqual(parseEvents(again).events, parseEvents(text).events);
  assert.equal(itemsToText(parseToItems(again)), again, 'saving twice gives the same file');
});

test('cards keep entries that could not be understood, and stray lines, as typed', async () => {
  const { parseToItems, itemsToText } = await import('../lib/events.js');
  const items = parseToItems('Date: 31/02/2027\nTitle: Bad date\n\nDate: 1/1/27\nRoom: Upstairs\nTitle: Good');
  assert.deepEqual(items.map((i) => i.kind), ['raw', 'event']);
  assert.equal(items[0].text, 'Date: 31/02/2027\nTitle: Bad date');
  assert.deepEqual(items[1].extra, ['Room: Upstairs']);
  const text = itemsToText(items);
  assert.match(text, /Title: Bad date/);
  assert.match(text, /Title: Good\nRoom: Upstairs/, 'stray lines go after the fields');
});

test('checkItem explains what a card is missing', async () => {
  const { checkItem } = await import('../lib/events.js');
  const blank = { kind: 'event', fields: { date: '', title: '' }, extra: [] };
  assert.match(checkItem(blank).problems[0], /empty/);
  assert.match(checkItem({ ...blank, fields: { date: '2027-01-01' } }).problems[0], /no "Title:"/);
  const ok = checkItem({ ...blank, fields: { date: '2027-01-01', title: 'Talk', type: 'social' } });
  assert.equal(ok.event.type, 'social');
  assert.deepEqual(ok.problems, []);
});
