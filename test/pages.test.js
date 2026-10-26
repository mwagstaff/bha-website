import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SECTIONS, resolveValues, forTemplates, cleanValue, createPagesStore, diffPages, toFileText } from '../lib/pages.js';

const section = (id) => SECTIONS.find((s) => s.id === id);

test('every section has a usable default', () => {
  const values = resolveValues();
  for (const s of SECTIONS) {
    assert.notEqual(values[s.id], undefined, s.id);
    assert.ok(s.kind === 'links' ? values[s.id].length : String(values[s.id]).trim(), `${s.id} is not empty`);
  }
  assert.equal(new Set(SECTIONS.map((s) => s.id)).size, SECTIONS.length, 'ids are unique');
});

test('damaged or missing values fall back to the default, one section at a time', () => {
  const values = resolveValues({ 'home.lede': 42, 'bulletin.price': '£12', 'links.list': 'oops', 'contact.editorEmail': 'nope' });
  assert.equal(values['home.lede'], section('home.lede').default);
  assert.equal(values['bulletin.price'], '£12');
  assert.equal(values['links.list'].length, section('links.list').default.length);
  assert.equal(values['contact.editorEmail'], section('contact.editorEmail').default);
});

test('each kind of value is tidied and made safe', () => {
  assert.equal(cleanValue(section('home.lede'), '  Lots   of\nspaces  '), 'Lots of spaces');
  assert.equal(cleanValue(section('bulletin.postal'), ' Line one \n\n  Line two '), 'Line one\nLine two');
  assert.equal(cleanValue(section('events.when'), '<b>Thursdays</b><img src=x onerror=alert(1)>'), '<b>Thursdays</b>');
  assert.equal(cleanValue(section('contact.editorEmail'), ' ann@example.org '), 'ann@example.org');
  assert.equal(cleanValue(section('contact.editorEmail'), 'ann at example'), undefined);
  assert.deepEqual(cleanValue(section('links.list'), [
    { name: 'Site', url: 'example.org', description: 'x' },
    { name: 'Mail', url: 'me@example.org' },
    { name: 'Local', url: '/events' },
    { name: 'Evil', url: 'javascript:alert(1)' },
    { name: 'Proto', url: '//evil.example' },
    { name: '', url: 'https://nameless.example' },
  ]).map((l) => l.url), ['https://example.org/', 'mailto:me@example.org', '/events', 'https://evil.example/'],
  'javascript: is dropped; "//evil.example" is just an ordinary https link, as if typed "evil.example"');
});

test('page templates get formatted text as safe HTML, with outside links opening a new tab', () => {
  const t = forTemplates(resolveValues({ 'home.intro': 'See <a href="/events">events</a> or <a href="https://x.org">x</a>' }));
  assert.equal(t['home.intro'], 'See <a href="/events">events</a> or <a target="_blank" rel="noopener noreferrer" href="https://x.org">x</a>');
  assert.deepEqual(t['bulletin.postal'].length > 1, true);
});

test('the store uses the defaults when there is no file, and the last good copy if the file breaks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bha-pages-'));
  const file = path.join(dir, 'pages.json');
  const load = createPagesStore(file);
  assert.equal(load().values['bulletin.price'], '£10');
  fs.writeFileSync(file, toFileText({ ...resolveValues(), 'bulletin.price': '£12' }));
  assert.equal(load().values['bulletin.price'], '£12');
  fs.writeFileSync(file, '{ this is not JSON');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(load().values['bulletin.price'], '£12', 'keeps the last good copy');
  fs.rmSync(dir, { recursive: true });
});

test('comparing versions lists only the sections that differ', () => {
  const live = resolveValues();
  const then = resolveValues({ 'bulletin.price': '£12', 'events.when': live['events.when'].replace('<b>', '<i>').replace('</b>', '</i>') });
  const { changed, unchanged } = diffPages(live, then);
  assert.deepEqual(changed.map((c) => [c.page, c.label]), [['Events', '"When" box'], ['Bulletin', 'Price']]);
  assert.equal(changed[0].formattingOnly, true);
  assert.equal(unchanged, SECTIONS.length - 2);
});
