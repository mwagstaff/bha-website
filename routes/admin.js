// The password-protected events editor (mounted at EDITOR_PATH in server.js).
//
// The page edits events as cards; the browser sends the cards back as JSON and
// the server writes them into the plain-text events file.

import express from 'express';
import ejs from 'ejs';
import fs from 'node:fs';
import path from 'node:path';
import { createAuth, sameOrigin } from '../lib/auth.js';
import { RICH_FIELDS, sanitizeRich } from '../lib/richtext.js';
import { forDisplay, versionOf, saveEventsFile, EditConflictError, parseToItems, itemsToText, checkItem, parseEvents, EDITABLE_FIELDS } from '../lib/events.js';
import { createHistory, UnknownVersionError, RETENTION_DAYS } from '../lib/history.js';
import { diffEvents } from '../lib/diff.js';
import { PAGES, SECTIONS, cleanValue, resolveValues, forTemplates, toFileText, parseFileText, problemWith, diffPages } from '../lib/pages.js';

const MAX_ITEMS = 500;

// Keeps only the parts of an item the editor is allowed to send.
function cleanItem(raw) {
  if (raw?.kind === 'raw') return { kind: 'raw', text: String(raw.text ?? '').slice(0, 5000) };
  const fields = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, String(raw?.fields?.[f] ?? '').slice(0, 2000)]));
  for (const f of RICH_FIELDS) fields[f] = sanitizeRich(fields[f]);
  const extra = Array.isArray(raw?.extra) ? raw.extra.map((l) => String(l).slice(0, 2000)) : [];
  return { kind: 'event', fields, extra };
}

function readItems(body) {
  if (!Array.isArray(body?.items) || body.items.length > MAX_ITEMS) return null;
  return body.items.map(cleanItem);
}

const whenFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
});

// "Thursday 22 October at 10:15am"
const when = (date) => whenFmt.format(date).replace(/\s([ap]m)$/i, (m, ap) => ap.toLowerCase());

function ago(date, now = Date.now()) {
  const mins = Math.round((now - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const KIND_LABELS = {
  saved: 'Changes saved',
  restored: 'An earlier version was put back',
  'before-restore': 'Automatic backup, made just before an earlier version was put back',
  earlier: 'Earlier version',
};

export function adminRouter({ eventsFile, history = createHistory(path.join(path.dirname(eventsFile), 'backups')), hero, basePath = '/edit-content', pages = null }) {
  // The login cookie is only sent to the editor's own pages.
  const auth = createAuth({ cookiePath: basePath });
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '10kb' });
  const json = express.json({ limit: '1mb' });

  if (!auth.enabled) console.warn('[admin] BHA_EDITOR_USERNAME and BHA_EDITOR_PASSWORD (8+ characters) must both be set; the events editor is locked.');

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.locals.noindex = true;
    res.locals.hero = hero;
    res.locals.editorBase = basePath;
    next();
  });

  const requireLogin = (req, res, next) => {
    if (auth.isLoggedIn(req)) return next();
    if (req.method === 'GET') return res.redirect(`${basePath}/login`);
    // The editor keeps everything typed, so it can simply ask her to log in again.
    if (req.is('json')) return res.status(401).json({ error: 'You have been logged out.' });
    res.redirect(`${basePath}/login`);
  };

  // Adds each item's preview card and any problems, ready for the page.
  async function describe(req, items) {
    const cardTemplate = path.join(req.app.get('views'), 'partials', 'event-card.ejs');
    const today = new Date().toISOString().slice(0, 10);
    return Promise.all(items.map(async (item) => {
      const { event, problems } = checkItem(item);
      if (!event) return { ...item, html: null, problems, past: false };
      const { upcoming, past } = forDisplay([event], today);
      const html = await ejs.renderFile(cardTemplate, { e: upcoming[0] || past[0] });
      return { ...item, html, problems, past: past.length > 0 };
    }));
  }

  router.get('/', (req, res) => res.redirect(`${basePath}/events`));

  router.get('/login', (req, res) => {
    if (auth.isLoggedIn(req)) return res.redirect(`${basePath}/events`);
    res.render('admin-login', { title: 'Editor login', enabled: auth.enabled, error: null });
  });

  router.post('/login', sameOrigin, form, (req, res) => {
    const result = auth.tryLogin(req, res, { username: req.body.username, password: req.body.password });
    if (result === 'ok') return res.redirect(`${basePath}/events`);
    const error = result === 'locked'
      ? 'Too many wrong attempts. Please wait 15 minutes and try again.'
      : "That username or password wasn't right. Please try again.";
    res.status(result === 'locked' ? 429 : 401).render('admin-login', { title: 'Editor login', enabled: auth.enabled, error });
  });

  router.post('/logout', sameOrigin, (req, res) => {
    auth.logout(res);
    res.redirect(`${basePath}/login`);
  });

  router.get('/events', requireLogin, async (req, res, next) => {
    try {
      auth.renew(req, res);
      const text = fs.readFileSync(eventsFile, 'utf8');
      const items = await describe(req, parseToItems(text));
      res.render('admin-events', { title: 'Edit events', editorData: { version: versionOf(text), items } });
    } catch (err) {
      next(err);
    }
  });

  // Live preview while editing: the rendered card and problems for each item.
  router.post('/events/preview', requireLogin, sameOrigin, json, async (req, res) => {
    const items = readItems(req.body);
    if (!items) return res.status(400).json({ error: 'Preview request was not understood.' });
    try {
      res.json({ items: await describe(req, items) });
    } catch (err) {
      console.error('[admin] Preview failed:', err);
      res.status(500).json({ error: 'Preview failed' });
    }
  });

  router.post('/events', requireLogin, sameOrigin, json, async (req, res) => {
    const items = readItems(req.body);
    if (!items) return res.status(400).json({ error: 'The changes were not understood, so nothing was saved.' });
    // New cards come with a time and type filled in, so those alone don't count.
    const kept = items.filter((i) => (i.kind === 'raw'
      ? i.text.trim()
      : Object.entries(i.fields).some(([f, v]) => f !== 'type' && f !== 'time' && v.trim())));
    if (!kept.length) {
      return res.status(400).json({ error: 'There are no events left, so nothing was saved. (To remove everything, please ask Mike.)' });
    }
    try {
      const text = itemsToText(kept);
      const version = saveEventsFile(eventsFile, text, { expectedVersion: req.body.version, history });
      console.log(`[admin] Events saved (${kept.length} entries)`);
      res.json({ version, items: await describe(req, parseToItems(text)) });
    } catch (err) {
      if (err instanceof EditConflictError) {
        return res.status(409).json({ error: 'Someone else saved the events while you were editing, so your changes have not been saved. Reload the page to see the latest version (your changes will be lost), or ask Mike for help.' });
      }
      console.error('[admin] Save failed:', err);
      res.status(500).json({ error: 'Sorry, something went wrong and the changes could not be saved. Please try again in a minute.' });
    }
  });

  // ---- Page text ----

  const readFile = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const livePageValues = () => resolveValues(parseFileText(readFile(pages.file)) || {});

  // Only known sections, each tidied; anything unusable keeps its current value.
  function mergePageValues(submitted, current) {
    const next = { ...current };
    const problems = {};
    for (const section of SECTIONS) {
      if (!submitted || !Object.hasOwn(submitted, section.id)) continue;
      const problem = problemWith(section, submitted[section.id]);
      if (problem) problems[section.id] = problem;
      const cleaned = cleanValue(section, submitted[section.id]);
      if (cleaned !== undefined) next[section.id] = cleaned;
    }
    return { values: next, problems };
  }

  if (pages) {
    router.get('/pages', requireLogin, (req, res) => {
      auth.renew(req, res);
      const text = readFile(pages.file);
      res.render('admin-pages', {
        title: 'Edit page text',
        editorData: {
          version: versionOf(text),
          values: livePageValues(),
          pages: PAGES,
          sections: SECTIONS.map(({ id, page, kind, label, hint }) => ({ id, page, kind, label, hint: hint || '' })),
        },
      });
    });

    // The real page, drawn with the unsaved text, for the preview frame.
    router.post('/pages/preview', requireLogin, sameOrigin, json, (req, res) => {
      const pageId = String(req.body?.page || '');
      if (!pages.views[pageId]) return res.status(400).json({ error: 'Unknown page.' });
      const { values, problems } = mergePageValues(req.body?.values, livePageValues());
      const [view, locals] = pages.views[pageId](req);
      res.render(view, { ...locals, pt: forTemplates(values), path: pages.paths[pageId], noindex: true }, (err, html) => {
        if (err) {
          console.error('[admin] Page preview failed:', err);
          return res.status(500).json({ error: 'Preview failed' });
        }
        // The preview frame needs to be told where the site's styles and images
        // live, and nothing in it can be clicked through to.
        const origin = `${req.protocol}://${req.get('host')}`;
        const frozen = html
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') // the preview never runs scripts anyway
          .replace('<head>', `<head><base href="${origin}/">`)
          .replace('</head>', '<style>a,button,summary,input,textarea{pointer-events:none}</style></head>');
        res.json({ html: frozen, problems });
      });
    });

    router.post('/pages', requireLogin, sameOrigin, json, (req, res) => {
      if (!req.body?.values || typeof req.body.values !== 'object') {
        return res.status(400).json({ error: 'The changes were not understood, so nothing was saved.' });
      }
      try {
        const { values, problems } = mergePageValues(req.body.values, livePageValues());
        // The very first save: keep the site's original wording in the history too.
        if (!fs.existsSync(pages.file) && versionOf('') === req.body.version) pages.history.snapshot(toFileText(livePageValues()), 'earlier');
        const version = saveEventsFile(pages.file, toFileText(values), { expectedVersion: req.body.version, history: pages.history });
        console.log('[admin] Page text saved');
        res.json({ version, values, problems });
      } catch (err) {
        if (err instanceof EditConflictError) {
          return res.status(409).json({ error: 'Someone else saved the page text while you were editing, so your changes have not been saved. Reload the page to see the latest version (your changes will be lost), or ask Mike for help.' });
        }
        console.error('[admin] Page text save failed:', err);
        res.status(500).json({ error: 'Sorry, something went wrong and the changes could not be saved. Please try again in a minute.' });
      }
    });
  }

  // ---- Version history (for the events, and for the page text) ----

  const DOCUMENTS = {
    events: {
      label: 'Events', file: eventsFile, history,
      compare: (liveText, text) => ({ type: 'events', d: diffEvents(parseEvents(liveText).events, parseEvents(text).events) }),
    },
    ...(pages && {
      pages: {
        label: 'Page text', file: pages.file, history: pages.history,
        compare: (liveText, text) => ({
          type: 'pages',
          d: diffPages(resolveValues(parseFileText(liveText) || {}), resolveValues(parseFileText(text) || {})),
        }),
      },
    }),
  };
  const docFor = (name) => (Object.hasOwn(DOCUMENTS, name) ? name : 'events');

  router.get('/history', requireLogin, (req, res) => {
    auth.renew(req, res);
    const docName = docFor(req.query.doc);
    const doc = DOCUMENTS[docName];
    const liveText = readFile(doc.file);
    const liveHash = versionOf(liveText);
    let liveMarked = false;
    const versions = doc.history.entries().map((entry) => {
      const { text } = doc.history.read(entry.id);
      // The newest copy of what's on the website now is marked as "live".
      const isLive = !liveMarked && versionOf(text) === liveHash;
      if (isLive) liveMarked = true;
      return {
        id: entry.id, kind: entry.kind, isLive,
        label: KIND_LABELS[entry.kind],
        when: when(entry.savedAt), ago: ago(entry.savedAt),
        from: entry.from && when(entry.from),
        diff: doc.compare(liveText, text),
      };
    });
    const what = docName === 'pages' ? 'page text' : 'events';
    const notice = { restored: 'Done. The earlier version is now on the website. If that was a mistake, put back the automatic backup listed just below it.',
      same: "That version is the same as what's on the website now, so nothing needed changing.",
      conflict: `The ${what} were changed while this page was open, so nothing was restored. Please look at the list again and try once more.`,
      missing: "That version couldn't be found. It may have been more than a week old." }[Object.keys(req.query).find((k) => k !== 'doc')];
    res.render('admin-history', {
      title: 'Version history', versions, version: liveHash, notice, retentionDays: RETENTION_DAYS,
      doc: docName, what, documents: Object.entries(DOCUMENTS).map(([name, d]) => ({ name, label: d.label })),
    });
  });

  router.post('/history/restore', requireLogin, sameOrigin, form, (req, res) => {
    const docName = docFor(req.body.doc);
    const doc = DOCUMENTS[docName];
    const back = (query) => res.redirect(`${basePath}/history?doc=${docName}&${query}=1`);
    let entry;
    try {
      entry = doc.history.read(String(req.body.id || ''));
    } catch (err) {
      if (err instanceof UnknownVersionError) return back('missing');
      throw err;
    }
    const liveText = readFile(doc.file);
    if (versionOf(entry.text) === versionOf(liveText)) return back('same');
    try {
      saveEventsFile(doc.file, entry.text, { expectedVersion: String(req.body.version || ''), history: doc.history, kind: 'restored', from: entry.savedAt });
      console.log(`[admin] Restored ${docName} version ${entry.id}`);
      back('restored');
    } catch (err) {
      if (err instanceof EditConflictError) return back('conflict');
      throw err;
    }
  });

  return router;
}
