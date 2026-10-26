import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff, diffEvents, readable } from '../lib/diff.js';

const text = (parts, keep) => parts.filter((p) => [ 'same', keep, `${keep}-space`].includes(p.type)).map((p) => p.text).join('');

test('word differences rebuild both the old and new text exactly', () => {
  const cases = [
    ['Pre-booking by 14 October essential.', 'Pre-booking by 21 October essential. Numbers limited.'],
    ['', 'Something new'],
    ['Something old', ''],
    ['Same words', 'Same words'],
    ['Dr. Gabrielle Storey', 'Professor Gabrielle Storey-Smith'],
  ];
  for (const [before, after] of cases) {
    const parts = wordDiff(before, after);
    assert.equal(text(parts, 'removed'), before);
    assert.equal(text(parts, 'added'), after);
  }
});

test('only the words that differ are marked', () => {
  const parts = wordDiff('Pre-booking by 14 October essential.', 'Pre-booking by 21 October essential.');
  assert.deepEqual(parts.filter((p) => p.type !== 'same').map((p) => [p.type, p.text]).sort(), [['added', '21'], ['removed', '14']]);
  assert.deepEqual(wordDiff('Same', 'Same'), [{ type: 'same', text: 'Same' }]);
  // The space before a removed word isn't part of the highlight.
  assert.deepEqual(wordDiff('website. Test.', 'website.').filter((p) => p.type === 'removed').map((p) => p.text), ['Test.']);
});

const ev = (fields) => ({ type: 'lecture', ...fields });

test('sorts events into added back, removed and changed', () => {
  const live = [ev({ date: '2026-10-22', title: 'Talk A' }), ev({ date: '2026-11-19', title: 'Talk B' }), ev({ date: '2026-12-03', title: 'Talk C' })];
  const then = [ev({ date: '2026-10-22', title: 'Talk A', note: 'Pre-booking essential.' }), ev({ date: '2026-11-19', title: 'Talk B' }), ev({ date: '2027-01-07', title: 'Talk D' })];
  const d = diffEvents(live, then);
  assert.deepEqual(d.added.map((e) => e.title), ['Talk D']);
  assert.deepEqual(d.removed.map((e) => e.title), ['Talk C']);
  assert.deepEqual(d.changed.map((e) => [e.title, e.changes.map((c) => c.field)]), [['Talk A', ['note']]]);
  assert.equal(d.unchanged, 1);
  assert.equal(d.total, 3);
  assert.deepEqual(d.added[0].details.map((f) => [f.label, f.text]), [['Date', 'Thursday 7 January 2027'], ['Type', 'Lecture'], ['Title', 'Talk D']]);
});

test('a renamed event or a moved event is one change, not a removal and an addition', () => {
  const d = diffEvents(
    [ev({ date: '2026-10-22', title: 'Bedding the Monarch' }), ev({ date: '2026-11-19', title: 'General Strike' })],
    [ev({ date: '2026-10-22', title: 'Bedding the Monarch: Scandal' }), ev({ date: '2026-11-26', title: 'General Strike' })],
  );
  assert.equal(d.added.length + d.removed.length, 0);
  assert.deepEqual(d.changed.map((e) => e.changes.map((c) => c.field)), [['title'], ['date']]);
  const date = d.changed[1].changes[0];
  assert.equal(text(date.parts, 'removed'), 'Thursday 19 November 2026');
  assert.equal(text(date.parts, 'added'), 'Thursday 26 November 2026');
});

test('two different events on the same day are not mistaken for one renamed event', () => {
  const d = diffEvents(
    [ev({ date: '2026-10-22', title: 'Morning visit' }), ev({ date: '2026-10-22', title: 'Evening talk' })],
    [ev({ date: '2026-10-22', title: 'Morning visit' }), ev({ date: '2026-10-22', title: 'Afternoon tea' })],
  );
  assert.deepEqual(d.removed.map((e) => e.title), ['Evening talk']);
  assert.deepEqual(d.added.map((e) => e.title), ['Afternoon tea']);
});

test('formatting-only changes are flagged, and shown safely', () => {
  const d = diffEvents(
    [ev({ date: '2026-10-22', title: 'T', description: 'A lively talk' })],
    [ev({ date: '2026-10-22', title: 'T', description: 'A <b>lively</b> talk<script>alert(1)</script>' })],
  );
  const [change] = d.changed[0].changes;
  assert.equal(change.formattingOnly, true);
  assert.equal(change.thenHtml, 'A <b>lively</b> talk');
});

test('fields read the way a person would write them', () => {
  assert.equal(readable('date', '2026-10-22'), 'Thursday 22 October 2026');
  assert.equal(readable('type', 'visit'), 'Visit');
  assert.equal(readable('note', 'Book <a href="https://x.org">here</a>'), 'Book here (https://x.org)');
  assert.equal(readable('time', ''), '');
});
