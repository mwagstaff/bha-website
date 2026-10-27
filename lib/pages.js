// Editable page text. Every section has a page, a label and hint for the
// editor, a kind (how it's edited and shown) and a default, which is the
// site's original wording. Values are saved as JSON; each one is checked on
// its own, so a damaged or missing value falls back to its default rather
// than breaking the page.
//
// Kinds:
//   text   one line of plain text          rich   formatted text (see richtext.js)
//   lines  several lines of plain text     email  an email address
//   links  a list of { name, url, description }
//
// Contact names and email addresses (shown on the pages, and where each form
// is sent) are sections too, so they can be changed in the editor. Where the
// forms are sent starts out as BHA_ENQUIRY_TO / BHA_BULLETIN_TO, if set.

import fs from 'node:fs';
import { contact, venue, links as defaultLinks } from '../data/site.js';
import { sanitizeRich, renderRich, richToText } from './richtext.js';
import { wordDiff } from './diff.js';

export const PAGES = [
  { id: 'home', label: 'Home', path: '/' },
  { id: 'events', label: 'Events', path: '/events' },
  { id: 'membership', label: 'Membership', path: '/membership' },
  { id: 'bulletin', label: 'Bulletin', path: '/bulletin' },
  { id: 'links', label: 'Links', path: '/links' },
  { id: 'contact', label: 'Contact Us', path: '/contact' },
];

export const MEMBERSHIP_FORM = '/files/branch-membership-form-2026-27.pdf';
const OLD_MEMBERSHIP_FORM = 'http://www.beckenham-historical-association.org/membershipA.pdf';
const env = (name) => String(process.env[name] ?? '').trim();
const enquiryTo = env('BHA_ENQUIRY_TO') || contact.programme.email;
const bulletinTo = env('BHA_BULLETIN_TO') || enquiryTo;
const mail = (email, subject) => `mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
const NOT_SHOWN = 'Not shown on the website';

export const SECTIONS = [
  // Home
  { id: 'home.lede', page: 'home', kind: 'text', label: 'Tagline', hint: 'The line under the big heading at the top of the page',
    default: 'Lectures, visits and good company for everyone with an interest in the past.' },
  { id: 'home.introTitle', page: 'home', kind: 'text', label: 'Introduction heading',
    default: 'One of an international network of branches' },
  { id: 'home.introLead', page: 'home', kind: 'rich', label: 'Introduction: opening paragraph', hint: 'Shown in slightly larger text',
    default: 'The Beckenham and Bromley branch of the <a href="https://www.history.org.uk/">Historical Association</a> is one of an international network of branches, and is located in the United Kingdom.' },
  { id: 'home.intro', page: 'home', kind: 'rich', label: 'Introduction: the rest', hint: 'Press Enter twice to start a new paragraph',
    default: 'The Historical Association itself was founded in 1906, with the Beckenham and Bromley branch being set up in 1947. The Association is a voluntary organisation for all people, whether professional or amateur historians, who have an interest in the past.<br><br>Full details of all <a href="/events">events</a> can be found in the branch\'s monthly <a href="/bulletin">bulletin</a>, the <i>Beckenham Historian</i>, which can be obtained directly from the editor at a cost of £10.00 per 10 issues.' },

  // Events
  { id: 'events.lede', page: 'events', kind: 'text', label: 'Tagline', hint: 'The line under the big heading at the top of the page',
    default: 'Thursday evening lectures, guided visits, outings and the occasional fish supper.' },
  { id: 'events.when', page: 'events', kind: 'rich', label: '"When" box',
    default: 'Meetings, as scheduled in the programme, take place on <b>Thursdays at 7.30 p.m.</b> in Beckenham unless otherwise stated. We serve tea and coffee before the meeting.' },
  { id: 'events.where', page: 'events', kind: 'rich', label: '"Where" box', hint: 'A "Map & directions" link is added underneath',
    default: `All Beckenham lectures take place in <b>${venue.name}</b>, ${venue.address}.` },
  { id: 'events.bookingName', page: 'events', kind: 'text', label: '"Booking" box: who to email', hint: 'Their name is the link to email them',
    default: contact.programme.name, required: true },
  { id: 'events.bookingRole', page: 'events', kind: 'text', label: '"Booking" box: their role', hint: 'Shown after their name; leave empty to leave it out',
    default: contact.programme.role },
  { id: 'events.bookingEmail', page: 'events', kind: 'email', label: '"Booking" box: their email address',
    default: contact.programme.email },
  { id: 'events.bookingText', page: 'events', kind: 'rich', label: '"Booking" box: the rest', hint: 'Follows "Email [name], [role],"',
    default: 'to request booking forms.' },
  { id: 'events.bookingNote', page: 'events', kind: 'text', label: '"Booking" box: small print',
    default: 'We follow all Government public health guidelines.' },

  // Membership
  { id: 'membership.lede', page: 'membership', kind: 'text', label: 'Tagline', hint: 'The line under the big heading at the top of the page',
    default: 'The branch is always happy to welcome new members!' },
  { id: 'membership.intro', page: 'membership', kind: 'rich', label: 'Introduction', hint: 'Shown in slightly larger text',
    default: `If you are interested in joining as a local branch member, you can download <a href="${MEMBERSHIP_FORM}">the Branch Membership Form</a> or simply complete this form and we will send you details about our branch.` },
  { id: 'membership.compareIntro', page: 'membership', kind: 'rich', label: '"Local or full membership?": introduction',
    default: 'If you wish, you may sign up for full, rather than just local, Historical Association membership.' },
  { id: 'membership.local', page: 'membership', kind: 'rich', label: 'Local membership', hint: 'The first shaded box',
    default: '<b>Local member</b> — attend all branch events.' },
  { id: 'membership.full', page: 'membership', kind: 'rich', label: 'Full HA membership', hint: 'The second shaded box',
    default: '<b>Full HA member</b> — attend meetings at other branches, educational conferences, national and international visits, receive HA publications, use numerous resources on the national website and more besides.' },
  { id: 'membership.signup', page: 'membership', kind: 'rich', label: 'How to sign up for full membership',
    default: 'To sign up for full membership, please visit the Historical Association <a href="https://www.history.org.uk/">membership</a> page.' },
  { id: 'membership.enquiryTo', page: 'membership', kind: 'email', label: '"Membership enquiry" form: send to', hint: NOT_SHOWN, private: true,
    default: enquiryTo },

  // Bulletin
  { id: 'bulletin.lede', page: 'bulletin', kind: 'text', label: 'Tagline', hint: 'The line under the big heading at the top of the page',
    default: 'The complete programme of branch events, plus a selection of history-related articles.' },
  { id: 'bulletin.intro', page: 'bulletin', kind: 'rich', label: 'Introduction', hint: 'Shown in slightly larger text',
    default: 'The <i>Beckenham Historian</i> is a monthly branch bulletin, containing a complete listing of upcoming branch <a href="/events">events</a> as well as a selection of history-related articles.' },
  { id: 'bulletin.price', page: 'bulletin', kind: 'text', label: 'Price', hint: 'Shown large, e.g. £10',
    default: '£10' },
  { id: 'bulletin.priceLabel', page: 'bulletin', kind: 'rich', label: 'Next to the price',
    default: 'for ten consecutive issues. You don\'t need to be a branch <a href="/membership">member</a> to subscribe.' },
  { id: 'bulletin.subscribe', page: 'bulletin', kind: 'rich', label: '"How to subscribe"',
    default: `To register your interest, complete the form or <a href="${mail(contact.editor.email, 'Beckenham Historian')}">email ${contact.editor.name}</a>, and we will contact you to arrange your subscription details.` },
  { id: 'bulletin.postIntro', page: 'bulletin', kind: 'rich', label: 'Before the postal address',
    default: 'To subscribe immediately, print this page and post it to:' },
  { id: 'bulletin.postal', page: 'bulletin', kind: 'lines', label: 'Postal address', hint: 'One line of the address per line',
    default: contact.postal.split(', ').join('\n') },
  { id: 'bulletin.cheque', page: 'bulletin', kind: 'rich', label: 'After the postal address',
    default: 'enclosing a cheque for £10.00 made payable to <b>J S Wagstaff</b>.' },
  { id: 'bulletin.enquiryTo', page: 'bulletin', kind: 'email', label: '"Register your interest" form: send to', hint: NOT_SHOWN, private: true,
    default: bulletinTo },

  // Links
  { id: 'links.lede', page: 'links', kind: 'text', label: 'Tagline', hint: 'The line under the big heading at the top of the page',
    default: 'Other organisations and websites for the curious local historian.' },
  { id: 'links.list', page: 'links', kind: 'links', label: 'The links', hint: 'Shown in this order',
    default: defaultLinks.map(({ name, url, description }) => ({ name, url, description })) },

  // Contact
  { id: 'contact.lede', page: 'contact', kind: 'text', label: 'Tagline', hint: 'The line under the big heading at the top of the page',
    default: "If you have any questions or comments, please don't hesitate to get in touch!" },
  { id: 'contact.editorName', page: 'contact', kind: 'text', label: '"The Beckenham Historian" card: name',
    default: contact.editor.name, required: true },
  { id: 'contact.editorRole', page: 'contact', kind: 'text', label: '"The Beckenham Historian" card: role', hint: 'Leave empty to leave it out',
    default: contact.editor.role },
  { id: 'contact.editorEmail', page: 'contact', kind: 'email', label: '"The Beckenham Historian" card: email address', hint: 'For the "Email the editor" button',
    default: contact.editor.email },
  { id: 'contact.programmeName', page: 'contact', kind: 'text', label: '"Events & bookings" card: name',
    default: contact.programme.name, required: true },
  { id: 'contact.programmeRole', page: 'contact', kind: 'text', label: '"Events & bookings" card: role', hint: 'Leave empty to leave it out',
    default: contact.programme.role },
  { id: 'contact.programmeEmail', page: 'contact', kind: 'email', label: '"Events & bookings" card: email address', hint: 'For the "Request booking forms" button',
    default: contact.programme.email },
  { id: 'contact.generalName', page: 'contact', kind: 'text', label: '"General enquiries" card: name',
    default: contact.general.name, required: true },
  { id: 'contact.generalRole', page: 'contact', kind: 'text', label: '"General enquiries" card: role', hint: 'Leave empty to leave it out',
    default: contact.general.role },
  { id: 'contact.generalEmail', page: 'contact', kind: 'email', label: '"General enquiries" card: email address', hint: 'For the "Send an email" button',
    default: contact.general.email },
  { id: 'contact.train', page: 'contact', kind: 'rich', label: 'Directions: by train',
    default: 'Clock House (from Charing Cross) or Beckenham Junction (from Victoria).' },
  { id: 'contact.tram', page: 'contact', kind: 'rich', label: 'Directions: by tram',
    default: 'Trams from Wimbledon and Croydon terminate at Beckenham Junction.' },
  { id: 'contact.bus', page: 'contact', kind: 'rich', label: 'Directions: by bus',
    default: 'Routes 54, 194, 227 and 358 stop nearby.' },
];

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MAX_LINKS = 50;

function linkAddress(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^\/(?!\/)/.test(text)) return text; // a page on this site, e.g. /events
  if (/^mailto:/i.test(text)) return EMAIL.test(text.slice(7)) ? text : null;
  if (EMAIL.test(text)) return `mailto:${text}`;
  const url = /^https?:\/\//i.test(text) ? text : `https://${text.replace(/^\/+/, '')}`;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname.includes('.') ? parsed.href : null;
  } catch {
    return null;
  }
}

// Returns a safe, tidied value for a section, or undefined if it can't be used.
export function cleanValue(section, value) {
  switch (section.kind) {
    case 'text': {
      const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined;
      return section.required && !text ? undefined : text;
    }
    case 'lines':
      return typeof value === 'string'
        ? value.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12).join('\n').slice(0, 600)
        : undefined;
    case 'email': {
      const email = typeof value === 'string' ? value.trim() : '';
      return EMAIL.test(email) ? email.slice(0, 200) : undefined;
    }
    case 'rich':
      return typeof value === 'string' ? sanitizeRich(value) : undefined;
    case 'links': {
      if (!Array.isArray(value)) return undefined;
      return value.slice(0, MAX_LINKS).map((l) => ({
        name: String(l?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
        url: linkAddress(l?.url) || '',
        description: String(l?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
      })).filter((l) => l.name && l.url);
    }
    default:
      return undefined;
  }
}

// Brings values saved by earlier versions of the site up to date.
function upgradeSaved(saved) {
  const intro = saved['membership.intro'];
  if (typeof intro === 'string' && intro.includes(OLD_MEMBERSHIP_FORM)) {
    return { ...saved, 'membership.intro': intro.replaceAll(OLD_MEMBERSHIP_FORM, MEMBERSHIP_FORM) };
  }
  return saved;
}

// Every section's value: the saved one if it's usable, otherwise the default.
export function resolveValues(saved = {}) {
  saved = upgradeSaved(saved);
  const values = {};
  for (const section of SECTIONS) {
    const cleaned = Object.hasOwn(saved, section.id) ? cleanValue(section, saved[section.id]) : undefined;
    values[section.id] = cleaned === undefined ? cleanValue(section, section.default) : cleaned;
  }
  return values;
}

// Explains, in plain words, why a value someone typed can't be used.
export function problemWith(section, value) {
  if (section.kind === 'text' && section.required && !String(value ?? '').trim()) {
    return 'This can\'t be left empty, so the old one will be kept.';
  }
  if (section.kind === 'email' && String(value ?? '').trim() && cleanValue(section, value) === undefined) {
    return `"${String(value).trim()}" doesn't look like an email address, so the old one will be kept.`;
  }
  if (section.kind === 'links' && Array.isArray(value)) {
    const bad = value.filter((l) => String(l?.name ?? '').trim() && !linkAddress(l?.url));
    if (bad.length) return `${bad.map((l) => `"${l.name}"`).join(', ')} ${bad.length === 1 ? "doesn't have" : "don't have"} a working web address, so ${bad.length === 1 ? 'it' : 'they'} won't be shown.`;
  }
  return null;
}

// What the page templates use: formatted text as safe HTML, everything else as plain values.
export function forTemplates(values) {
  const out = {};
  for (const section of SECTIONS) {
    const v = values[section.id];
    out[section.id] = section.kind === 'rich' ? renderRich(v) : section.kind === 'lines' ? v.split('\n') : v;
  }
  return out;
}

export function toFileText(values) {
  return `${JSON.stringify(values, null, 2)}\n`;
}

export function parseFileText(text) {
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// Re-reads the file when it changes; if it can't be read or understood,
// the last good copy (or the defaults) are used and the problem is logged.
export function createPagesStore(file) {
  const defaults = resolveValues();
  let cache = { mtimeMs: -1, values: defaults, text: null, templates: forTemplates(defaults) };
  return function load() {
    try {
      if (!fs.existsSync(file)) return cache;
      const { mtimeMs } = fs.statSync(file);
      if (mtimeMs !== cache.mtimeMs) {
        const text = fs.readFileSync(file, 'utf8');
        const saved = parseFileText(text);
        if (!saved) {
          console.error(`[pages] ${file} couldn't be understood; showing the last version that worked.`);
          cache = { ...cache, mtimeMs };
        } else {
          const values = resolveValues(saved);
          cache = { mtimeMs, values, text, templates: forTemplates(values) };
        }
      }
    } catch (err) {
      console.error(`[pages] Couldn't read ${file}: ${err.message}. Showing the last version that worked.`);
    }
    return cache;
  };
}

// ---- Comparing two versions, for Version history ----

function sectionText(section, value) {
  if (section.kind === 'rich') return richToText(value);
  if (section.kind === 'links') return value.map((l) => `${l.name} (${l.url.replace(/^mailto:/, '')})${l.description ? `: ${l.description}` : ''}`).join('\n');
  return String(value ?? '');
}

// Sections whose text differs between what's live now and an older version.
export function diffPages(liveValues, versionValues) {
  const pageLabel = Object.fromEntries(PAGES.map((p) => [p.id, p.label]));
  const changed = [];
  for (const section of SECTIONS) {
    const a = liveValues[section.id];
    const b = versionValues[section.id];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const textA = sectionText(section, a);
    const textB = sectionText(section, b);
    changed.push({
      page: pageLabel[section.page], label: section.label,
      parts: wordDiff(textA, textB),
      formattingOnly: section.kind === 'rich' && textA === textB,
      nowHtml: section.kind === 'rich' ? sanitizeRich(a) : null,
      thenHtml: section.kind === 'rich' ? sanitizeRich(b) : null,
    });
  }
  return { changed, unchanged: SECTIONS.length - changed.length };
}

export const sectionById = (id) => BY_ID.get(id);

// A saved page-text file without the private settings (where the forms are
// sent), for keeping a copy somewhere public such as git.
export function withoutPrivate(saved) {
  return Object.fromEntries(Object.entries(saved).filter(([id]) => !BY_ID.get(id)?.private));
}
