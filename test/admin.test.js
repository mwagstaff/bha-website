import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { adminRouter } from '../routes/admin.js';
import { createHistory } from '../lib/history.js';
import { createPagesStore } from '../lib/pages.js';
import { saveEventsFile, versionOf, EditConflictError } from '../lib/events.js';

const PASSWORD = 'test-password-for-unit-tests';
const USERNAME = 'test-editor';
const EDITOR = '/edit-content';
let dir, eventsFile, pagesFile, server, base;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bha-admin-'));
  eventsFile = path.join(dir, 'events.txt');
  fs.writeFileSync(eventsFile, 'Date: 1/1/2099\nTitle: Seed event\n');
  process.env.BHA_EDITOR_PASSWORD = PASSWORD;
  process.env.BHA_EDITOR_USERNAME = USERNAME;
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../views', import.meta.url).pathname);
  app.locals.assetVersion = 'test';
  pagesFile = path.join(dir, 'pages.json');
  const loadPages = createPagesStore(pagesFile);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  app.use((req, res, next) => { Object.assign(res.locals, { nav: [], path: req.path, contact: {}, venue: {}, images: {}, pt: loadPages().templates, esc }); next(); });
  const hero = { src: '', caption: '', source: '' };
  app.use(EDITOR, adminRouter({
    eventsFile, hero, basePath: EDITOR,
    pages: {
      file: pagesFile, history: createHistory(path.join(dir, 'backups', 'pages')), load: loadPages,
      views: { links: () => ['links', { title: 'Links', hero }], membership: () => ['membership', { title: 'Membership', hero, sent: false }] },
      paths: { links: '/links', membership: '/membership' },
    },
  }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true });
  delete process.env.BHA_EDITOR_PASSWORD;
  delete process.env.BHA_EDITOR_USERNAME;
});

const form = (data) => ({ method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });

async function login(password = PASSWORD, username = USERNAME) {
  const res = await fetch(`${base}${EDITOR}/login`, form({ username, password }));
  const cookie = res.headers.get('set-cookie');
  return { res, cookie: cookie && cookie.split(';')[0] };
}

const postJson = (url, cookie, body, extra = {}) => fetch(`${base}${url}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
  body: JSON.stringify(body),
});

async function editorData(cookie) {
  const html = await (await fetch(`${base}${EDITOR}/events`, { headers: { cookie } })).text();
  const json = html.match(/<script type="application\/json" id="editor-data">([\s\S]*?)<\/script>/)[1];
  return JSON.parse(json);
}

const event = (fields) => ({ kind: 'event', fields: { date: '', time: '', type: 'lecture', kicker: '', title: '', speaker: '', location: '', description: '', note: '', ...fields }, extra: [] });

test('the editor needs a login', async () => {
  const res = await fetch(`${base}${EDITOR}/events`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${EDITOR}/login`);
  const save = await postJson(`${EDITOR}/events`, null, { items: [event({ date: '2027-01-01', title: 'Hacked' })] });
  assert.equal(save.status, 401);
  assert.match(fs.readFileSync(eventsFile, 'utf8'), /Seed event/);
});

test('a wrong password is refused, the right one lets you in', async () => {
  const wrong = await login('nope');
  assert.equal(wrong.res.status, 401);
  assert.equal(wrong.cookie, null);

  const { res, cookie } = await login();
  assert.equal(res.status, 302);
  const data = await editorData(cookie);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].fields.title, 'Seed event');
  assert.match(data.items[0].html, /Seed event/);
});

test('a tampered cookie is rejected', async () => {
  const { cookie } = await login();
  const [name, value] = cookie.split('=');
  const [, sig] = value.split('.');
  const forged = `${name}=${Date.now() + 1e12}.${sig}`;
  const res = await fetch(`${base}${EDITOR}/events`, { headers: { cookie: forged }, redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('the preview shows each card and its problems without saving', async () => {
  const { cookie } = await login();
  const res = await postJson(`${EDITOR}/events/preview`, cookie, {
    items: [event({ date: '2099-02-02', title: 'Previewed' }), event({ title: 'No date' }), { kind: 'raw', text: 'Date: 3/3/2099\nTitle: Fixed raw' }],
  });
  const { items } = await res.json();
  assert.match(items[0].html, /Previewed/);
  assert.equal(items[0].problems.length, 0);
  assert.equal(items[1].html, null);
  assert.match(items[1].problems[0], /no "Date:"/);
  assert.match(items[2].html, /Fixed raw/, 'a raw entry that has been fixed previews as a card');
  assert.equal(fs.readFileSync(eventsFile, 'utf8').includes('Previewed'), false, 'preview must not save');
});

test('saving cards writes the events file, keeps a backup and returns the sorted cards', async () => {
  const { cookie } = await login();
  const { version } = await editorData(cookie);
  const res = await postJson(`${EDITOR}/events`, cookie, {
    version,
    items: [
      event({ date: '2099-03-03', time: '7.30pm', title: 'Later', description: 'Two\nlines' }),
      event({ date: '2099-01-01', title: 'Earlier', type: 'visit' }),
      { kind: 'raw', text: 'Date: 31/02/2099\n\nTitle: Still broken' },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const text = fs.readFileSync(eventsFile, 'utf8');
  assert.match(text, /Date: 03\/03\/2099\nTime: 19:30\nType: Lecture\nTitle: Later\nDescription: Two<br>lines/, "line breaks are kept");
  assert.ok(text.indexOf('Earlier') < text.indexOf('Later'), 'saved in date order');
  assert.match(text, /Date: 31\/02\/2099\nTitle: Still broken/, 'a broken entry is kept as typed, minus blank lines');
  assert.deepEqual(body.items.map((i) => i.fields?.title ?? 'raw'), ['raw', 'Earlier', 'Later']);
  assert.equal(body.version, versionOf(text));
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.ok(backups.some((f) => fs.readFileSync(path.join(dir, 'backups', f), 'utf8').includes('Seed event')));
});

test('a save based on an out-of-date copy is refused', async () => {
  const { cookie } = await login();
  const res = await postJson(`${EDITOR}/events`, cookie, { version: 'old-version', items: [event({ date: '2099-04-04', title: 'Stale edit' })] });
  assert.equal(res.status, 409);
  assert.equal(fs.readFileSync(eventsFile, 'utf8').includes('Stale edit'), false);
});

test('saving with every event removed or empty is refused', async () => {
  const { cookie } = await login();
  const before = fs.readFileSync(eventsFile, 'utf8');
  for (const items of [[], [event({})], [event({ time: '19:30' })], [{ kind: 'raw', text: '   ' }]]) {
    const res = await postJson(`${EDITOR}/events`, cookie, { version: versionOf(before), items });
    assert.equal(res.status, 400);
  }
  assert.equal(fs.readFileSync(eventsFile, 'utf8'), before);
});

test('malformed requests are refused', async () => {
  const { cookie } = await login();
  assert.equal((await postJson(`${EDITOR}/events`, cookie, { items: 'nope' })).status, 400);
  assert.equal((await postJson(`${EDITOR}/events/preview`, cookie, {})).status, 400);
});

test('posts from another website are blocked', async () => {
  const { cookie } = await login();
  const res = await postJson(`${EDITOR}/events`, cookie, { items: [event({ date: '2099-05-05', title: 'CSRF' })] }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('formatted descriptions are kept, and anything unsafe is removed before saving', async () => {
  const { cookie } = await login();
  const { version } = await editorData(cookie);
  const res = await postJson(`${EDITOR}/events`, cookie, {
    version,
    items: [event({
      date: '2099-06-06', title: 'Formatted',
      description: '<b>Bold</b> and <a href="https://example.org" onclick="steal()">a link</a><script>alert(1)</script><img src=x onerror=alert(1)>',
      note: '<a href="javascript:alert(1)">Book</a> <i>soon</i>',
    })],
  });
  assert.equal(res.status, 200);
  const text = fs.readFileSync(eventsFile, 'utf8');
  assert.match(text, /Description: <b>Bold<\/b> and <a href="https:\/\/example.org">a link<\/a>\n/);
  assert.match(text, /Note: Book <i>soon<\/i>\n/);
  assert.doesNotMatch(text, /<script|alert\(|onerror|onclick|javascript:/);
  const { items } = await res.json();
  assert.match(items[0].html, /<b>Bold<\/b>/);
  assert.match(items[0].html, /target="_blank" rel="noopener noreferrer" href="https:\/\/example.org"/);
});

const restoreForm = (cookie, data, extra = {}) => fetch(`${base}${EDITOR}/history/restore`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...extra },
  body: new URLSearchParams(data),
});

test('the version history lists saves and can put an earlier one back', async () => {
  const { cookie } = await login();
  const before = fs.readFileSync(eventsFile, 'utf8');
  const page = await (await fetch(`${base}${EDITOR}/history`, { headers: { cookie } })).text();
  assert.match(page, /On the website now/);
  const ids = [...page.matchAll(/name="id" value="([^"]+)"/g)].map((m) => m[1]);
  const version = page.match(/name="version" value="([^"]+)"/)[1];
  assert.ok(ids.length > 0, 'older versions can be restored');

  const target = ids.find((id) => id.includes('--saved--')) || ids[0];
  const res = await restoreForm(cookie, { id: target, version });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${EDITOR}/history?doc=events&restored=1`);
  assert.notEqual(fs.readFileSync(eventsFile, 'utf8'), before);

  // The version that was replaced is now an automatic backup, and can itself be put back.
  const after = await (await fetch(`${base}${EDITOR}/history`, { headers: { cookie } })).text();
  assert.match(after, /Automatic backup, made just before an earlier version was put back/);
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  const backup = backups.find((f) => f.includes('--before-restore--'));
  assert.equal(fs.readFileSync(path.join(dir, 'backups', backup), 'utf8'), before);
  const undo = await restoreForm(cookie, { id: backup.replace(/\.txt$/, ''), version: versionOf(fs.readFileSync(eventsFile, 'utf8')) });
  assert.equal(undo.headers.get('location'), `${EDITOR}/history?doc=events&restored=1`);
  assert.equal(fs.readFileSync(eventsFile, 'utf8'), before);
});

test('restoring refuses unknown versions, out-of-date pages, logged-out and cross-site requests', async () => {
  const { cookie } = await login();
  const live = fs.readFileSync(eventsFile, 'utf8');
  const backup = fs.readdirSync(path.join(dir, 'backups')).find((f) => f.includes('--saved--')).replace(/\.txt$/, '');

  assert.equal((await restoreForm(cookie, { id: '../events', version: versionOf(live) })).headers.get('location'), `${EDITOR}/history?doc=events&missing=1`);
  const stale = await restoreForm(cookie, { id: backup, version: 'out-of-date' });
  assert.ok([`${EDITOR}/history?doc=events&conflict=1`, `${EDITOR}/history?doc=events&same=1`].includes(stale.headers.get('location')));
  assert.equal((await restoreForm(null, { id: backup, version: versionOf(live) })).headers.get('location'), `${EDITOR}/login`);
  assert.equal((await restoreForm(cookie, { id: backup, version: versionOf(live) }, { origin: 'https://evil.example' })).status, 403);
  assert.equal(fs.readFileSync(eventsFile, 'utf8'), live);
});

test('the version history shows exactly which words would change', async () => {
  const { cookie } = await login();
  let { version } = await editorData(cookie);
  const save = async (note) => {
    const res = await postJson(`${EDITOR}/events`, cookie, { version, items: [event({ date: '2099-07-07', title: 'Diffed', note })] });
    ({ version } = await res.json());
  };
  await save('Pre-booking by 14 October essential.');
  await save('Pre-booking by 21 October essential.');
  const page = await (await fetch(`${base}${EDITOR}/history`, { headers: { cookie } })).text();
  assert.match(page, /Would be changed \(1\)/);
  // Live now says 21; the older version says 14.
  assert.match(page, /<del>21<\/del>/);
  assert.match(page, /<ins>14<\/ins>/);
});

test('a wrong username is refused, and usernames ignore capitals and spaces', async () => {
  assert.equal((await login(PASSWORD, 'someone-else')).res.status, 401);
  assert.equal((await login(PASSWORD, '')).res.status, 401);
  const { res, cookie } = await login(PASSWORD, '  Test-Editor ');
  assert.equal(res.status, 302);
  assert.ok(cookie);
});

test('the login cookie is only sent to the editor pages', async () => {
  const res = await fetch(`${base}${EDITOR}/login`, form({ username: USERNAME, password: PASSWORD }));
  assert.match(res.headers.get('set-cookie'), /Path=\/edit-content/);
});

test('the editor stays locked unless both a username and a password are set', async () => {
  const { createAuth } = await import('../lib/auth.js');
  assert.equal(createAuth({ username: '', password: 'long-enough-password' }).enabled, false);
  assert.equal(createAuth({ username: 'editor', password: 'short' }).enabled, false);
  assert.equal(createAuth({ username: 'editor', password: 'long-enough-password' }).enabled, true);
});

test('page text: the editor lists every section with its current wording', async () => {
  const { cookie } = await login();
  const html = await (await fetch(`${base}${EDITOR}/pages`, { headers: { cookie } })).text();
  const data = JSON.parse(html.match(/<script type="application\/json" id="editor-data">([\s\S]*?)<\/script>/)[1]);
  assert.ok(data.sections.length > 20);
  assert.equal(data.values['bulletin.price'], '£10');
  assert.ok(Array.isArray(data.values['links.list']) && data.values['links.list'].length > 0);
});

test('page text: the preview draws the real page with unsaved words, safely', async () => {
  const { cookie } = await login();
  const res = await postJson(`${EDITOR}/pages/preview`, cookie, {
    page: 'membership',
    values: { 'membership.lede': 'Join <us> today', 'membership.local': '<b>Local</b> members<script>alert(1)</script>' },
  });
  const { html } = await res.json();
  assert.match(html, /Join &#60;us&#62; today|Join &lt;us&gt; today/, 'plain text is escaped');
  assert.match(html, /<b>Local<\/b> members/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.equal(fs.existsSync(pagesFile), false, 'preview must not save');
});

test('page text: saving keeps good changes, refuses bad ones, and records a version', async () => {
  const { cookie } = await login();
  const before = await (await fetch(`${base}${EDITOR}/pages`, { headers: { cookie } })).text();
  const { version, values } = JSON.parse(before.match(/id="editor-data">([\s\S]*?)<\/script>/)[1]);
  const res = await postJson(`${EDITOR}/pages`, cookie, {
    version,
    values: {
      'bulletin.price': '£12',
      'contact.editorEmail': 'not an email',
      'links.list': [{ name: 'Good', url: 'www.example.org', description: 'Fine' }, { name: 'Bad', url: 'javascript:alert(1)', description: '' }],
      'made.up': 'ignored',
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.values['bulletin.price'], '£12');
  assert.equal(body.values['contact.editorEmail'], values['contact.editorEmail'], 'a bad email keeps the old one');
  assert.match(body.problems['contact.editorEmail'], /doesn't look like an email/);
  assert.deepEqual(body.values['links.list'], [{ name: 'Good', url: 'https://www.example.org/', description: 'Fine' }]);
  assert.match(body.problems['links.list'], /"Bad"/);
  const saved = JSON.parse(fs.readFileSync(pagesFile, 'utf8'));
  assert.equal(saved['bulletin.price'], '£12');
  assert.equal(saved['made.up'], undefined);

  const stale = await postJson(`${EDITOR}/pages`, cookie, { version, values: { 'bulletin.price': '£99' } });
  assert.equal(stale.status, 409, 'a save from an out-of-date page is refused');
});

test('page text: version history shows the changed words and can put the old text back', async () => {
  const { cookie } = await login();
  const page = await (await fetch(`${base}${EDITOR}/history?doc=pages`, { headers: { cookie } })).text();
  assert.match(page, /History of the page text/);
  assert.match(page, /Bulletin page/);
  assert.match(page, /<del>£12<\/del>/);
  assert.match(page, /<ins>£10<\/ins>/);
  const id = page.match(/name="doc" value="pages">\s*<input type="hidden" name="id" value="([^"]+)"/)[1];
  const version = versionOf(fs.readFileSync(pagesFile, 'utf8'));
  const res = await restoreForm(cookie, { doc: 'pages', id, version });
  assert.equal(res.headers.get('location'), `${EDITOR}/history?doc=pages&restored=1`);
  assert.equal(JSON.parse(fs.readFileSync(pagesFile, 'utf8'))['bulletin.price'], '£10');
  assert.ok(fs.readdirSync(path.join(dir, 'backups', 'pages')).some((f) => f.includes('--before-restore--')));
});

test('repeated wrong passwords lock out further attempts', async () => {
  for (let i = 0; i < 5; i++) await login('wrong');
  const { res } = await login();
  assert.equal(res.status, 429);
});
