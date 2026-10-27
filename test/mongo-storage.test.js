// The Mongo storage, against a throwaway in-memory Mongo (mongodb-memory-server
// downloads a mongod binary the first time it runs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { openStorage } from '../lib/storage.js';
import { saveEventsFile, versionOf, EditConflictError } from '../lib/events.js';
import { createHistory, UnknownVersionError } from '../lib/history.js';
import { adminRouter } from '../routes/admin.js';

let mongod;
let dbCount = 0;
const dirs = [];
const opened = [];

before(async () => { mongod = await MongoMemoryServer.create(); });
after(async () => {
  await Promise.all(opened.map((s) => s.close()));
  await mongod.stop();
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

const EVENTS = 'Date: 1/1/2099\nTitle: From the file\n';

// A data folder like the server's, with events, page text and some history.
function dataFolder({ events = EVENTS, pages = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bha-mongo-'));
  dirs.push(dir);
  if (events) fs.writeFileSync(path.join(dir, 'events.txt'), events);
  if (pages) fs.writeFileSync(path.join(dir, 'pages.json'), JSON.stringify(pages));
  return dir;
}

async function open(dataDir, { uri = `${mongod.getUri()}bha_test_${++dbCount}`, gitCopyDir = null } = {}) {
  const storage = await openStorage({
    mode: 'mongo', uri, dataDir, backupDir: path.join(dataDir, 'backups'),
    seedEventsFile: new URL('../content/events.txt', import.meta.url).pathname, gitCopyDir,
  });
  opened.push(storage);
  return { storage, uri };
}

test('the first time, the files and their history are copied into Mongo; after that Mongo is used', async () => {
  const dataDir = dataFolder();
  const eventsFile = path.join(dataDir, 'events.txt');
  const history = createHistory(path.join(dataDir, 'backups'));
  saveEventsFile(eventsFile, 'Date: 2/2/2099\nTitle: Second version\n', { history });
  saveEventsFile(eventsFile, 'Date: 3/3/2099\nTitle: Third version\n', { history });
  const pagesFile = path.join(dataDir, 'pages.json');
  const pagesHistory = createHistory(path.join(dataDir, 'backups', 'pages'));
  saveEventsFile(pagesFile, JSON.stringify({ 'bulletin.price': '£12' }), { history: pagesHistory });
  saveEventsFile(pagesFile, JSON.stringify({ 'bulletin.price': '£11' }), { history: pagesHistory });

  const { storage, uri } = await open(dataDir);
  assert.equal((await storage.docs.pages.history.entries()).length, 2, 'copied once, though events and pages start together');
  assert.deepEqual(storage.loadEvents().events.map((e) => e.title), ['Third version']);
  assert.equal(storage.loadPages().values['bulletin.price'], '£11');
  const entries = await storage.docs.events.history.entries();
  assert.deepEqual(entries.map((e) => e.kind), ['saved', 'saved', 'earlier'], 'newest first, kinds kept');
  assert.match((await storage.docs.events.history.read(entries.at(-1).id)).text, /From the file/);
  assert.deepEqual(storage.health(), { storage: 'mongo', database: 'ok' });

  // Changing the file afterwards makes no difference.
  fs.writeFileSync(eventsFile, 'Date: 4/4/2099\nTitle: Edited by hand\n');
  const again = await open(dataDir, { uri });
  assert.deepEqual(again.storage.loadEvents().events.map((e) => e.title), ['Third version']);
  assert.equal((await again.storage.docs.events.history.entries()).length, 3, 'history is not copied twice');
});

test('events are stored as structured fields, not text', async () => {
  const { storage, uri } = await open(dataFolder());
  const client = await MongoClient.connect(uri);
  const doc = await client.db().collection('content').findOne({ _id: 'events' });
  await client.close();
  assert.deepEqual(doc.data.items[0].fields.title, 'From the file');
  assert.equal(doc.data.items[0].fields.date, '2099-01-01');
  assert.equal(doc.version, versionOf(await storage.docs.events.read()));
});

test('with no data folder, events start from the bundled copy and page text from the defaults', async () => {
  const { storage } = await open(dataFolder({ events: null }));
  assert.ok(storage.loadEvents().events.length > 5);
  assert.equal(storage.loadPages().values['bulletin.price'], '£10');
  assert.equal(await storage.docs.pages.read(), '');
});

test('saving: the public pages see it at once, and an out-of-date save is refused', async () => {
  const { storage } = await open(dataFolder());
  const { events } = storage.docs;
  const version = versionOf(await events.read());
  const next = await events.save('Date: 5/5/2099\nTitle: Saved\n', { expectedVersion: version });
  assert.deepEqual(storage.loadEvents().events.map((e) => e.title), ['Saved']);
  assert.equal(next, versionOf(await events.read()));
  await assert.rejects(events.save('Date: 6/6/2099\nTitle: Stale\n', { expectedVersion: version }), EditConflictError);

  // Two saves from the same starting point: only one wins.
  const results = await Promise.allSettled([
    events.save('Date: 7/7/2099\nTitle: First\n', { expectedVersion: next }),
    events.save('Date: 8/8/2099\nTitle: Second\n', { expectedVersion: next }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.ok(results.find((r) => r.status === 'rejected').reason instanceof EditConflictError);
});

test('putting back an earlier version backs up the current one first; unknown versions are refused', async () => {
  const { storage } = await open(dataFolder());
  const { events } = storage.docs;
  await events.save('Date: 5/5/2099\nTitle: Newer\n', { expectedVersion: versionOf(await events.read()) });
  const [, older] = await events.history.entries();
  const { text, savedAt } = await events.history.read(older.id);
  await events.save(text, { expectedVersion: versionOf(await events.read()), kind: 'restored', from: savedAt });
  assert.deepEqual(storage.loadEvents().events.map((e) => e.title), ['From the file']);
  const [restored, backup] = await events.history.entries();
  assert.equal(restored.kind, 'restored');
  assert.equal(restored.from.getTime(), savedAt.getTime());
  assert.equal(backup.kind, 'before-restore');
  assert.match((await events.history.read(backup.id)).text, /Newer/);
  await assert.rejects(events.history.read('not-an-id'), UnknownVersionError);
  await assert.rejects(events.history.read('0123456789abcdef01234567'), UnknownVersionError);
});

test('old versions are pruned, keeping the newest 10 however old', async () => {
  const { storage } = await open(dataFolder());
  const { history } = storage.docs.events;
  const longAgo = new Date(Date.now() - 30 * 864e5);
  for (let i = 0; i < 12; i++) await history.snapshot(`Date: 1/1/2099\nTitle: Old ${i}\n`, 'saved', { savedAt: new Date(longAgo.getTime() + i) });
  await history.prune();
  assert.equal((await history.entries()).length, 10);
});

test('if Mongo is unreachable, the pages are drawn from the copy kept in git', async () => {
  const gitCopyDir = dataFolder({ events: 'Date: 9/9/2099\nTitle: In git\n', pages: { 'bulletin.price': '£13' } });
  const { storage } = await open(dataFolder(), { uri: 'mongodb://127.0.0.1:9/bha?serverSelectionTimeoutMS=300', gitCopyDir });
  assert.deepEqual(storage.loadEvents().events.map((e) => e.title), ['In git']);
  assert.equal(storage.loadPages().values['bulletin.price'], '£13');
  assert.deepEqual(storage.health(), { storage: 'mongo', database: 'unreachable' });
  await storage.recordEnquiry({ name: 'Never lost' }); // logged, never thrown
});

test('enquiries are recorded', async () => {
  const { storage, uri } = await open(dataFolder());
  await storage.recordEnquiry({ formtype: 'Membership Enquiry', name: 'Ada', status: 'sent' });
  const client = await MongoClient.connect(uri);
  const [saved] = await client.db().collection('enquiries').find().toArray();
  await client.close();
  assert.equal(saved.name, 'Ada');
  assert.ok(saved.receivedAt instanceof Date);
});

test('the editor saves, lists and restores versions in Mongo', async () => {
  const { storage } = await open(dataFolder());
  process.env.BHA_EDITOR_USERNAME = 'test-editor';
  process.env.BHA_EDITOR_PASSWORD = 'test-password-for-unit-tests';
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../views', import.meta.url).pathname);
  app.locals.assetVersion = 'test';
  const hero = { src: '', caption: '', source: '' };
  app.use((req, res, next) => { Object.assign(res.locals, { nav: [], path: req.path, contact: {}, venue: {}, images: {}, pt: storage.loadPages().templates, esc: String }); next(); });
  app.use('/edit-content', adminRouter({ docs: storage.docs, hero, pages: { views: { links: () => ['links', { title: 'Links', hero }] }, paths: { links: '/links' } } }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/edit-content`;
  try {
    const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=test-editor&password=test-password-for-unit-tests' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const json = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });

    const editor = await (await fetch(`${base}/events`, { headers: { cookie } })).text();
    const { version } = JSON.parse(editor.match(/id="editor-data">([\s\S]*?)<\/script>/)[1]);
    const fields = { date: '2099-10-10', time: '', type: 'lecture', kicker: '', title: 'Via the editor', speaker: '', location: '', description: '', note: '' };
    const saved = await json('/events', { version, items: [{ kind: 'event', fields, extra: [] }] });
    assert.equal(saved.status, 200);
    assert.deepEqual(storage.loadEvents().events.map((e) => e.title), ['Via the editor']);

    const pagesPage = await (await fetch(`${base}/pages`, { headers: { cookie } })).text();
    const pagesVersion = JSON.parse(pagesPage.match(/id="editor-data">([\s\S]*?)<\/script>/)[1]).version;
    assert.equal((await json('/pages', { version: pagesVersion, values: { 'bulletin.price': '£14' } })).status, 200);
    assert.equal(storage.loadPages().values['bulletin.price'], '£14');

    const history = await (await fetch(`${base}/history`, { headers: { cookie } })).text();
    const ids = [...history.matchAll(/name="id" value="([0-9a-f]{24})"/g)].map((m) => m[1]);
    const live = history.match(/name="version" value="([^"]+)"/)[1];
    const restore = await fetch(`${base}/history/restore`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie, origin: `http://127.0.0.1:${server.address().port}` },
      body: new URLSearchParams({ doc: 'events', id: ids.at(-1), version: live }),
    });
    assert.equal(restore.headers.get('location'), '/edit-content/history?doc=events&restored=1');
    assert.deepEqual(storage.loadEvents().events.map((e) => e.title), ['From the file']);
  } finally {
    server.close();
    delete process.env.BHA_EDITOR_USERNAME;
    delete process.env.BHA_EDITOR_PASSWORD;
  }
});

test('after a save or restore, onSaved runs once the public pages have the change', async () => {
  const seen = [];
  const dataDir = dataFolder();
  const storage = await openStorage({
    mode: 'mongo', uri: `${mongod.getUri()}bha_test_${++dbCount}`, dataDir, backupDir: path.join(dataDir, 'backups'),
    seedEventsFile: new URL('../content/events.txt', import.meta.url).pathname,
    onSaved: async (name) => seen.push([name, storage.loadEvents().events[0].title]),
  });
  opened.push(storage);
  await storage.docs.events.save('Date: 5/5/2099\nTitle: Saved\n', { expectedVersion: versionOf(await storage.docs.events.read()) });
  assert.deepEqual(seen, [['events', 'Saved']]);
});
