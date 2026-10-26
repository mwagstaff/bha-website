import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHistory, RETENTION_DAYS, MIN_KEEP, UnknownVersionError } from '../lib/history.js';
import { saveEventsFile, versionOf, EditConflictError } from '../lib/events.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bha-history-'));
  let clock = new Date('2026-10-01T09:00:00Z');
  const history = createHistory(path.join(dir, 'backups'), { now: () => clock });
  const file = path.join(dir, 'events.txt');
  return {
    dir, file, history,
    tick(ms) { clock = new Date(clock.getTime() + ms); },
    cleanup: () => fs.rmSync(dir, { recursive: true }),
  };
}

test('each save is recorded as a version, newest first', () => {
  const t = setup();
  fs.writeFileSync(t.file, 'v0\n');
  saveEventsFile(t.file, 'v1', { history: t.history });
  t.tick(1000);
  saveEventsFile(t.file, 'v2', { history: t.history });
  const list = t.history.entries();
  assert.deepEqual(list.map((e) => e.kind), ['saved', 'saved', 'earlier'], 'the original file is kept as an "earlier" version');
  assert.deepEqual(list.map((e) => t.history.read(e.id).text), ['v2\n', 'v1\n', 'v0\n']);
  t.cleanup();
});

test('keeps 7 days of versions, but always at least the newest 10', () => {
  const t = setup();
  fs.writeFileSync(t.file, 'start\n');
  for (let i = 1; i <= 30; i++) {
    saveEventsFile(t.file, `v${i}`, { history: t.history });
    t.tick(864e5 / 2); // two saves a day
  }
  const list = t.history.entries();
  const newest = list[0].savedAt.getTime();
  assert.ok(list.every((e, i) => i < MIN_KEEP || newest - e.savedAt.getTime() <= RETENTION_DAYS * 864e5));
  assert.ok(list.length >= 14 && list.length <= 16, `about a week of versions (${list.length})`);

  // After a quiet month, the newest 10 are still there.
  t.tick(30 * 864e5);
  saveEventsFile(t.file, 'after a quiet month', { history: t.history });
  assert.equal(t.history.entries().length, MIN_KEEP);
  t.cleanup();
});

test('restoring backs up the current version first, and the restore can be undone', () => {
  const t = setup();
  fs.writeFileSync(t.file, 'good\n');
  saveEventsFile(t.file, 'good', { history: t.history });
  t.tick(1000);
  saveEventsFile(t.file, 'oops', { history: t.history });
  const good = t.history.entries().find((e) => t.history.read(e.id).text === 'good\n');

  t.tick(1000);
  saveEventsFile(t.file, t.history.read(good.id).text, { history: t.history, kind: 'restored', from: good.savedAt });
  assert.equal(fs.readFileSync(t.file, 'utf8'), 'good\n');
  const [restored, before] = t.history.entries();
  assert.equal(restored.kind, 'restored');
  assert.equal(restored.from.getTime(), good.savedAt.getTime());
  assert.equal(before.kind, 'before-restore');
  assert.equal(t.history.read(before.id).text, 'oops\n');

  // Undo the restore by restoring the automatic backup.
  t.tick(1000);
  saveEventsFile(t.file, t.history.read(before.id).text, { history: t.history, kind: 'restored', from: before.savedAt });
  assert.equal(fs.readFileSync(t.file, 'utf8'), 'oops\n');
  assert.equal(t.history.entries()[1].kind, 'before-restore', 'every restore makes its own backup');
  t.cleanup();
});

test('only versions in the history can be read: no paths or made-up names', () => {
  const t = setup();
  fs.writeFileSync(t.file, 'x\n');
  saveEventsFile(t.file, 'y', { history: t.history });
  for (const id of ['../events', '../../etc/passwd', 'nope', '', t.history.entries()[0].id + '/../x']) {
    assert.throws(() => t.history.read(id), UnknownVersionError, id);
  }
  t.cleanup();
});

test('backups made before version history existed are listed as earlier versions', () => {
  const t = setup();
  fs.mkdirSync(t.history.dir, { recursive: true });
  fs.writeFileSync(path.join(t.history.dir, 'events-2026-09-30T08-00-00-000Z-abc123.txt'), 'legacy\n');
  fs.writeFileSync(path.join(t.history.dir, 'notes.txt'), 'ignored');
  const [entry] = t.history.entries();
  assert.equal(entry.kind, 'earlier');
  assert.equal(t.history.read(entry.id).text, 'legacy\n');
  assert.equal(t.history.entries().length, 1);
  t.cleanup();
});

test('a save from an out-of-date page is refused and nothing is recorded', () => {
  const t = setup();
  fs.writeFileSync(t.file, 'a\n');
  assert.throws(() => saveEventsFile(t.file, 'b', { history: t.history, expectedVersion: versionOf('old\n') }), EditConflictError);
  assert.equal(t.history.entries().length, 0);
  saveEventsFile(t.file, 'b', { history: t.history, expectedVersion: versionOf('a\n') });
  assert.equal(fs.readFileSync(t.file, 'utf8'), 'b\n');
  t.cleanup();
});
