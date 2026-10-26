import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contact, venue, images } from './data/site.js';
import { createEventsStore, ensureEventsFile, forDisplay } from './lib/events.js';
import { adminRouter } from './routes/admin.js';
import { createHistory } from './lib/history.js';
import { buildCalendar, CALENDAR_NAME } from './lib/ical.js';
import { createPagesStore } from './lib/pages.js';
import { readEnquiry, isSpam, sendEnquiry } from './lib/enquiry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The live, editable events file lives in a data folder outside the deployed
// code; content/events.txt is only the starting copy.
const dataDir = process.env.BHA_DATA_DIR || path.join(__dirname, 'var');
const eventsFile = path.join(dataDir, 'events.txt');
ensureEventsFile(eventsFile, path.join(__dirname, 'content', 'events.txt'));
// Timestamped versions of the events file (the last 7 days), for "Version history".
const history = createHistory(process.env.BHA_BACKUP_DIR || path.join(dataDir, 'backups'));
const loadEvents = createEventsStore(eventsFile);
const backupDir = process.env.BHA_BACKUP_DIR || path.join(dataDir, 'backups');

// Editable page text (headings, introductions, contact details…). Anything
// missing or unreadable falls back to the site's original wording.
const pagesFile = path.join(dataDir, 'pages.json');
const pagesHistory = createHistory(path.join(backupDir, 'pages'));
const loadPages = createPagesStore(pagesFile);

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = express();
const PORT = process.env.PORT || 3000;

// Behind Cloudflare -> Caddy in production.
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Changes on every restart (i.e. every deploy), so browsers fetch fresh CSS/JS.
app.locals.assetVersion = Date.now().toString(36);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use(express.urlencoded({ extended: false }));

const nav = [
  { href: '/', label: 'Home' },
  { href: '/events', label: 'Events' },
  { href: '/membership', label: 'Membership' },
  { href: '/bulletin', label: 'Bulletin' },
  { href: '/links', label: 'Links' },
  { href: '/contact', label: 'Contact Us' },
];

function splitEvents() {
  return forDisplay(loadEvents().events);
}

// Used by the deploy script's post-deploy check.
app.get('/healthcheck', (req, res) => res.json({ status: 'ok' }));

app.use((req, res, next) => {
  res.locals = { ...res.locals, nav, path: req.path, contact, venue, images, year: new Date().getFullYear(), pt: loadPages().templates, esc: escapeHtml };
  next();
});


// Links for the "Add our events to your calendar" buttons. Subscribing (rather
// than importing) means new events turn up in people's calendars by themselves.
function calendarLinks(req) {
  const feed = `${req.protocol}://${req.get('host')}/events.ics`;
  const webcal = feed.replace(/^https?:/, 'webcal:');
  return {
    apple: webcal,
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(feed)}&name=${encodeURIComponent(CALENDAR_NAME)}`,
    feed,
    download: '/events.ics?download=1',
  };
}

// Each public page's template and data, used by its route and by the page-text preview.
const PAGE_VIEWS = {
  home: () => ['home', { title: 'Home', hero: images.highStreet, next: splitEvents().upcoming.slice(0, 3) }],
  events: (req) => ['events', { title: 'Events', hero: images.churchHill, calendar: calendarLinks(req), ...splitEvents() }],
  membership: (req) => ['membership', { title: 'Membership', hero: images.hospital, sent: req.query.sent, failed: req.query.failed }],
  bulletin: (req) => ['bulletin', { title: 'Bulletin', hero: images.flood, sent: req.query.sent, failed: req.query.failed }],
  links: () => ['links', { title: 'Links', hero: images.crystalPalace }],
  contact: () => ['contact', { title: 'Contact Us', hero: images.churchHill }],
};
const PAGE_PATHS = { home: '/', events: '/events', membership: '/membership', bulletin: '/bulletin', links: '/links', contact: '/contact' };
// Cloudflare may keep public pages for a few minutes (browsers always revalidate),
// so edits show up within PUBLIC_CACHE and bots rarely reach the server.
const PUBLIC_CACHE = 'public, max-age=0, s-maxage=300';
for (const [id, pagePath] of Object.entries(PAGE_PATHS)) {
  app.get(pagePath, (req, res) => res.set('Cache-Control', PUBLIC_CACHE).render(...PAGE_VIEWS[id](req)));
}

app.get('/events.ics', (req, res) => {
  const host = req.get('host');
  const ics = buildCalendar(loadEvents().events, { venue, host, eventsUrl: `${req.protocol}://${host}/events` });
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Cache-Control': 'public, max-age=3600, s-maxage=300',
    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="bha-events.ics"`,
  });
  res.send(ics);
});

// The events editor lives at a deliberately unguessable-looking address, and
// nothing else on the site links to or redirects there.
const EDITOR_PATH = '/edit-content';
app.use(EDITOR_PATH, adminRouter({
  eventsFile, history, hero: images.churchHill, basePath: EDITOR_PATH,
  pages: { file: pagesFile, history: pagesHistory, load: loadPages, views: PAGE_VIEWS, paths: PAGE_PATHS },
}));


// Membership and bulletin enquiries (the PHP site posted to formSubmit.php).
app.post('/enquiry', async (req, res) => {
  const back = req.body.formtype === 'Bulletin Request' ? '/bulletin' : '/membership';
  if (isSpam(req.body)) return res.redirect(303, `${back}?sent=1#form`);
  const enquiry = readEnquiry(req.body);
  if (!enquiry) return res.status(400).send('Name, address and postcode are required.');
  try {
    if (!(await sendEnquiry(enquiry))) console.log(`[enquiry] email not configured; ${enquiry.formtype}:`, enquiry);
  } catch (err) {
    console.error(`[enquiry] ${err.message}; ${enquiry.formtype}:`, enquiry);
    return res.redirect(303, `${back}?failed=1#form`);
  }
  res.redirect(303, `${back}?sent=1#form`);
});

// Keep old PHP URLs working.
const legacy = { '/index.php': '/', '/events.php': '/events', '/membership.php': '/membership', '/bulletin.php': '/bulletin', '/links.php': '/links', '/contactus.php': '/contact' };
for (const [from, to] of Object.entries(legacy)) app.get(from, (req, res) => res.redirect(301, to));

app.use((req, res) => res.status(404).render('404', { title: 'Not found', hero: images.flood }));

app.listen(PORT, () => console.log(`BHA site running at http://localhost:${PORT}`));
