// Where the editable content is kept: the events, the page text and their
// version history, plus a log of enquiries.
//
//   BHA_STORAGE=file   (the default) files in the data folder, as before
//   BHA_STORAGE=mongo  MongoDB at MONGODB_URI_BHA
//
// Either way each document ("events", "pages") is read and saved as text in
// its file format, so the editor, version history and comparisons work the
// same. In Mongo the text is stored as structured data:
//
//   content    { _id: 'events', data: { items: [...] }, version, updatedAt }
//              { _id: 'pages', data: { values: {...} }, version, updatedAt }
//   history    { doc, savedAt, kind, from, hash, data }  one per saved version
//   enquiries  { receivedAt, formtype, name, ..., to, status, error }
//
// Each document is a single Mongo document, so a save is all-or-nothing on any
// Mongo (no transactions needed), and it only goes through if nobody else
// saved since the editor was opened.
//
// The public pages never wait for Mongo: they're drawn from an in-memory copy,
// refreshed after every save and every minute. If Mongo can't be reached the
// last copy (or, at startup, the copy kept in git in content/live/) is used.
// The first time Mongo is used, the data folder's files and their history are
// copied in.

import fs from 'node:fs';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { parseEvents, parseToItems, itemsToText, versionOf, saveEventsFile, EditConflictError, createEventsStore, ensureEventsFile } from './events.js';
import { createHistory, hashOf, UnknownVersionError, RETENTION_DAYS, MIN_KEEP } from './history.js';
import { resolveValues, forTemplates, parseFileText, toFileText, createPagesStore } from './pages.js';

const normalise = (text) => `${String(text).replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`;

// How each document's text is stored in Mongo, and turned back into text.
export const CODECS = {
  events: {
    toData: (text) => ({ items: parseToItems(text) }),
    toText: (data) => itemsToText(data?.items || []),
  },
  pages: {
    toData: (text) => ({ values: parseFileText(text) || {} }),
    toText: (data) => toFileText(data?.values || {}),
  },
};

// What the public pages use, worked out from a document's text.
const parsePages = (text) => {
  const values = resolveValues(parseFileText(text) || {});
  return { values, text: text || null, templates: forTemplates(values) };
};
const parseEventsText = (text) => {
  const parsed = parseEvents(text);
  parsed.problems.forEach((p) => console.warn(`[events] ${p}`));
  return parsed;
};

// ---- Files ----

export function createFileDoc(file, history) {
  return {
    history,
    read: async () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''),
    save: async (text, options = {}) => saveEventsFile(file, text, { ...options, history }),
  };
}

// ---- Mongo ----

export function createMongoHistory(collection, doc, codec, { now = () => new Date() } = {}) {
  let last = 0;
  const toEntry = (d) => ({ id: d._id.toHexString(), kind: d.kind, savedAt: d.savedAt, from: d.from || null, hash: d.hash });

  async function entries() {
    const docs = await collection.find({ doc }, { projection: { data: 0 } }).sort({ savedAt: -1, _id: -1 }).toArray();
    return docs.map(toEntry);
  }

  async function read(id) {
    const found = /^[0-9a-f]{24}$/.test(String(id)) && await collection.findOne({ _id: new ObjectId(String(id)), doc });
    if (!found) throw new UnknownVersionError(`No version called ${id}`);
    return { ...toEntry(found), text: codec.toText(found.data) };
  }

  async function snapshot(text, kind, { from = null, savedAt = null } = {}) {
    const data = codec.toData(text);
    // Versions saved in the same millisecond still come out in the right order.
    let at = (savedAt || now()).getTime();
    if (!savedAt) { if (at <= last) at = last + 1; last = at; }
    const entry = { doc, savedAt: new Date(at), kind, from, hash: hashOf(codec.toText(data)), data };
    const { insertedId } = await collection.insertOne(entry);
    return toEntry({ ...entry, _id: insertedId });
  }

  async function isLatest(text) {
    const newest = await collection.findOne({ doc }, { sort: { savedAt: -1, _id: -1 }, projection: { hash: 1 } });
    return Boolean(newest) && newest.hash === hashOf(text);
  }

  async function prune() {
    const cutoff = now().getTime() - RETENTION_DAYS * 864e5;
    const old = (await entries()).filter((e, i) => i >= MIN_KEEP && e.savedAt.getTime() < cutoff);
    if (old.length) await collection.deleteMany({ _id: { $in: old.map((e) => new ObjectId(e.id)) } });
  }

  return { entries, read, snapshot, isLatest, prune };
}

export function createMongoDoc(db, name, { now = () => new Date(), onSaved = () => {} } = {}) {
  const codec = CODECS[name];
  const content = db.collection('content');
  const history = createMongoHistory(db.collection('history'), name, codec, { now });
  const conflict = () => new EditConflictError(`The ${name} were changed somewhere else since this page was opened.`);

  async function read() {
    const current = await content.findOne({ _id: name });
    return current ? codec.toText(current.data) : '';
  }

  // Same rules as saving the file: "restored" backs up what it replaces first,
  // and anything not yet in the history is added to it before being replaced.
  async function save(text, { expectedVersion, kind = 'saved', from = null } = {}) {
    const data = codec.toData(normalise(text));
    const stored = codec.toText(data);
    const current = await content.findOne({ _id: name });
    const currentText = current ? codec.toText(current.data) : '';
    if (expectedVersion && versionOf(currentText) !== expectedVersion) throw conflict();
    if (current) {
      if (kind === 'restored') await history.snapshot(currentText, 'before-restore');
      else if (!(await history.isLatest(currentText))) await history.snapshot(currentText, 'earlier');
    }
    const version = versionOf(stored);
    const fields = { data, version, updatedAt: now() };
    if (current) {
      // Only replaces the version that was read just now, so two saves can't both win.
      const { matchedCount } = await content.updateOne({ _id: name, version: current.version }, { $set: fields });
      if (!matchedCount) throw conflict();
    } else {
      try {
        await content.insertOne({ _id: name, ...fields });
      } catch (err) {
        if (err.code === 11000) throw conflict();
        throw err;
      }
    }
    await history.snapshot(stored, kind, { from });
    await history.prune();
    await onSaved(name);
    return version;
  }

  return { history, read, save };
}

// The first time Mongo is used: copies in a document's file and its history
// (oldest first), unless Mongo already has that document.
export async function importFromFiles(db, name, { file, historyDir, seedFile = null }) {
  const content = db.collection('content');
  if (await content.findOne({ _id: name }, { projection: { _id: 1 } })) return false;
  const codec = CODECS[name];
  const mongoHistory = createMongoHistory(db.collection('history'), name, codec);
  if (await db.collection('history').findOne({ doc: name })) {
    console.warn(`[storage] Mongo has history for ${name} but no current version; not importing its history again.`);
  } else if (historyDir) {
    const fileHistory = createHistory(historyDir);
    for (const entry of fileHistory.entries().reverse()) {
      const { text } = fileHistory.read(entry.id);
      await mongoHistory.snapshot(text, entry.kind, { from: entry.from, savedAt: entry.savedAt });
    }
  }
  const source = [file, seedFile].find((f) => f && fs.existsSync(f));
  if (!source) return false;
  const data = codec.toData(fs.readFileSync(source, 'utf8'));
  try {
    await content.insertOne({ _id: name, data, version: versionOf(codec.toText(data)), updatedAt: new Date() });
  } catch (err) {
    if (err.code === 11000) return false; // another process got there first
    throw err;
  }
  console.log(`[storage] Copied ${name} from ${source} into Mongo`);
  return true;
}

// An in-memory copy of a document for the public pages, kept up to date in the background.
export function createLiveCache(read, parse, { initialText = '', label, intervalMs = 60_000, beforeRefresh = async () => {} } = {}) {
  let cache = parse(initialText);
  let lastText = null;
  let ok = false;
  let failing = false;
  async function refresh() {
    try {
      await beforeRefresh();
      const text = await read();
      if (text && text !== lastText) {
        cache = parse(text);
        lastText = text;
      }
      ok = true;
      if (failing) console.log(`[storage] ${label}: reading from Mongo again`);
      failing = false;
    } catch (err) {
      ok = false;
      if (!failing) console.error(`[storage] ${label}: couldn't read from Mongo (${err.message}); showing the last copy.`);
      failing = true;
    }
  }
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
  return { load: () => cache, refresh, isOk: () => ok, stop: () => clearInterval(timer) };
}

// Sets up the chosen storage. Returns the editor's documents (docs.events,
// docs.pages), the public pages' loaders, and somewhere to record enquiries.
export async function openStorage({
  mode = 'file', uri = '', dataDir, backupDir, seedEventsFile, gitCopyDir = null, intervalMs,
}) {
  const files = {
    events: { file: path.join(dataDir, 'events.txt'), historyDir: backupDir, seedFile: seedEventsFile },
    pages: { file: path.join(dataDir, 'pages.json'), historyDir: path.join(backupDir, 'pages') },
  };

  if (mode !== 'mongo') {
    ensureEventsFile(files.events.file, seedEventsFile);
    const loadEvents = createEventsStore(files.events.file);
    const loadPages = createPagesStore(files.pages.file);
    return {
      mode: 'file',
      docs: {
        events: createFileDoc(files.events.file, createHistory(files.events.historyDir)),
        pages: createFileDoc(files.pages.file, createHistory(files.pages.historyDir)),
      },
      loadEvents,
      loadPages,
      recordEnquiry: async () => {},
      health: () => ({ storage: 'file' }),
      close: async () => {},
    };
  }

  if (!uri) throw new Error('BHA_STORAGE=mongo needs MONGODB_URI_BHA');
  // A small pool: the live server is short of memory, and the site makes few queries.
  const client = new MongoClient(uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 5000, appName: 'bha-website' });
  const db = client.db();

  // Runs once, however many readers ask at the same time; tried again if it fails.
  let setUpOnce = null;
  function setUp() {
    setUpOnce ??= (async () => {
      await db.collection('history').createIndex({ doc: 1, savedAt: -1 });
      await db.collection('enquiries').createIndex({ receivedAt: -1 });
      for (const [name, where] of Object.entries(files)) await importFromFiles(db, name, where);
    })().catch((err) => { setUpOnce = null; throw err; });
    return setUpOnce;
  }

  // Until Mongo has been read, pages are drawn from the copy kept in git.
  const gitCopy = (name, fallback = '') => {
    for (const f of [gitCopyDir && path.join(gitCopyDir, name), fallback].filter(Boolean)) {
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    }
    return '';
  };
  const caches = {};
  const docs = {};
  for (const name of ['events', 'pages']) {
    docs[name] = createMongoDoc(db, name, { onSaved: () => caches[name].refresh() });
    caches[name] = createLiveCache(docs[name].read, name === 'events' ? parseEventsText : parsePages, {
      label: name, intervalMs, beforeRefresh: setUp,
      initialText: name === 'events' ? gitCopy('events.txt', seedEventsFile) : gitCopy('pages.json'),
    });
  }
  await Promise.all(Object.values(caches).map((c) => c.refresh()));

  return {
    mode: 'mongo',
    docs,
    loadEvents: caches.events.load,
    loadPages: caches.pages.load,
    // Never stops an enquiry going through: a failure is only logged.
    async recordEnquiry(enquiry) {
      try {
        await db.collection('enquiries').insertOne({ receivedAt: new Date(), ...enquiry });
      } catch (err) {
        console.error(`[storage] Couldn't record the enquiry in Mongo: ${err.message}`);
      }
    },
    health: () => ({ storage: 'mongo', database: caches.events.isOk() && caches.pages.isOk() ? 'ok' : 'unreachable' }),
    async close() {
      Object.values(caches).forEach((c) => c.stop());
      await client.close();
    },
  };
}
