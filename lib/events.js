// Reads the events programme from a forgiving plain-text file.
//
// Each event is a block of "Label: value" lines; blank lines separate events.
// Anything the parser can't understand is reported as a "problem" and skipped,
// so one bad entry never takes down the rest of the programme.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RICH_FIELDS, sanitizeRich, renderRich } from './richtext.js';
import { createHistory } from './history.js';

const FIELD_ALIASES = {
  date: ['date', 'when', 'day'],
  time: ['time', 'start', 'starts', 'start time'],
  type: ['type', 'kind', 'category'],
  kicker: ['intro', 'kicker', 'heading', 'before'],
  title: ['title', 'talk', 'event', 'subject', 'name', 'lecture'],
  speaker: ['speaker', 'speakers', 'by', 'who', 'presenter', 'lecturer'],
  location: ['location', 'where', 'venue', 'at', 'place'],
  description: ['description', 'details', 'about', 'info', 'summary'],
  note: ['note', 'notes', 'booking', 'please note'],
};
const FIELD_BY_LABEL = new Map(
  Object.entries(FIELD_ALIASES).flatMap(([field, labels]) => labels.map((l) => [l, field])),
);

const TYPE_ALIASES = {
  lecture: ['lecture', 'lectures', 'talk', 'talks', 'meeting', 'agm'],
  visit: ['visit', 'visits', 'trip', 'outing', 'walk', 'tour', 'excursion'],
  social: ['social', 'socials', 'dinner', 'supper', 'tea', 'party', 'lunch'],
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Accepts full names or abbreviations ("Oct", "Sept"), but not near-misses.
function monthIndex(word) {
  const w = word.toLowerCase();
  const i = w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w)) : -1;
  return i === -1 ? null : i + 1;
}

// Allows one slip (a wrong, missing, extra or swapped letter) in labels longer than four letters.
function closeEnough(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1)
    || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
}

// Fields that only ever hold one short value, so later lines never run on into them.
const SINGLE_LINE = new Set(['date', 'time', 'type']);

function fullYear(y) {
  const n = Number(y);
  return y.length <= 2 ? 2000 + n : n;
}

function isoDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

// Dates are read the British way round (day first).
export function parseDate(raw) {
  const s = raw
    .toLowerCase()
    .replace(/\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\b,?/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/\bof\b|,/g, ' ')
    .trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return isoDate(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})\s*[-/.\s]\s*(\d{1,2})\s*[-/.\s]\s*(\d{2}|\d{4})$/))) return isoDate(fullYear(m[3]), +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})\s*[-\s.]?\s*([a-z]+)\.?\s*[-\s.]?\s*(\d{2}|\d{4})$/))) {
    const month = monthIndex(m[2]);
    return month && isoDate(fullYear(m[3]), month, +m[1]);
  }
  if ((m = s.match(/^([a-z]+)\.?\s+(\d{1,2})\s+(\d{2}|\d{4})$/))) {
    const month = monthIndex(m[1]);
    return month && isoDate(fullYear(m[3]), month, +m[2]);
  }
  return null;
}

// Times are only displayed, so anything unrecognised is shown exactly as typed.
export function tidyTime(raw) {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/) || s.match(/^(\d{2})(\d{2})$/);
  if (!m) return raw.trim();
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const suffix = m[3] ? m[3][0] : '';
  if (suffix === 'p' && h < 12) h += 12;
  if (suffix === 'a' && h === 12) h = 0;
  if (!m[2] && !suffix && m.length === 4) return raw.trim(); // a lone number like "7" is ambiguous
  if (h > 23 || min > 59) return raw.trim();
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function normaliseType(raw, ev) {
  const word = (raw || '').trim().toLowerCase();
  for (const [type, words] of Object.entries(TYPE_ALIASES)) if (words.includes(word)) return type;
  // Not given (or not recognised): guess from the wording.
  const text = `${ev.kicker || ''} ${ev.title || ''}`.toLowerCase();
  if (/\b(visit|walk|stroll|outing|tour|trip|excursion|coach)\b/.test(text)) return 'visit';
  if (/\b(dinner|supper|tea|lunch|party)\b/.test(text)) return 'social';
  return 'lecture';
}

const LABEL_LINE = /^([A-Za-z][A-Za-z ]{0,20}?)\s*[:\-–=]\s*(.*)$/;

function knownLabel(label) {
  const l = label.trim().toLowerCase();
  if (FIELD_BY_LABEL.has(l)) return FIELD_BY_LABEL.get(l);
  for (const [known, field] of FIELD_BY_LABEL) if (closeEnough(l, known)) return field;
  return null;
}

// Returns { field, value } for a "Label: value" line, or null.
function labelOf(line) {
  const m = line.match(LABEL_LINE);
  const field = m && knownLabel(m[1]);
  if (field) return { field, value: m[2].trim() };
  // Also accept a forgotten colon ("Date 22/10/2026"), but only for a date or
  // time that genuinely follows, so ordinary sentences aren't misread.
  const loose = line.match(/^([A-Za-z]+)\s+(.+)$/);
  const looseField = loose && knownLabel(loose[1]);
  if (looseField === 'date' && parseDate(loose[2])) return { field: 'date', value: loose[2].trim() };
  if (looseField === 'time' && /^\d/.test(loose[2])) return { field: 'time', value: loose[2].trim() };
  return null;
}

function splitBlocks(text) {
  const blocks = [];
  let current = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    const isBreak = trimmed === '' || /^[-=*_~]{3,}$/.test(trimmed);
    if (isBreak || trimmed.startsWith('#')) {
      if (isBreak && current) { blocks.push(current); current = null; }
      return;
    }
    // A second "Date:" means a new event, even if the blank line was forgotten.
    if (current && labelOf(trimmed)?.field === 'date' && current.lines.some((l) => labelOf(l)?.field === 'date')) {
      blocks.push(current);
      current = null;
    }
    if (!current) current = { line: i + 1, lines: [] };
    current.lines.push(trimmed);
  });
  if (current) blocks.push(current);
  return blocks;
}

function parseBlock(block) {
  const fields = {};
  const unknown = [];
  let last = null;
  for (const line of block.lines) {
    const m = line.match(LABEL_LINE);
    const labelled = labelOf(line);
    if (labelled) {
      const { field, value } = labelled;
      fields[field] = fields[field] ? `${fields[field]} ${value}` : value;
      last = field;
    } else if (m && (!last || SINGLE_LINE.has(last))) {
      unknown.push(line);
    } else if (last && !SINGLE_LINE.has(last)) {
      // A line without a recognised label carries on the previous one.
      fields[last] = `${fields[last]} ${line}`.trim();
    } else {
      unknown.push(line);
    }
  }
  return { fields, unknown };
}

// Works out one block. Returns { event, problems, unknown } where event is
// null if the block can't be shown at all.
function interpretBlock(block, where) {
  const { fields, unknown } = parseBlock(block);
  const short = (s) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
  if (!fields.date) {
    return { event: null, unknown, problems: [`${where} ("${short(block.lines[0])}") has no "Date:" line, so it has been left out.`] };
  }
  const date = parseDate(fields.date);
  if (!date) {
    return { event: null, unknown, problems: [`${where}: couldn't understand the date "${fields.date}" (try something like 22/10/2026), so it has been left out.`] };
  }
  if (!fields.title && !fields.speaker) {
    return { event: null, unknown, problems: [`${where} (${fields.date}) has no "Title:" line, so it has been left out.`] };
  }
  const problems = [];
  if (unknown.length) {
    problems.push(`${where} (${fields.date}): ignored a line that didn't start with a recognised label ("${short(unknown[0])}"). The rest of the event is shown.`);
  }
  const ev = { ...fields, date };
  if (!ev.title) { ev.title = ev.speaker; delete ev.speaker; }
  if (ev.time) ev.time = tidyTime(ev.time);
  ev.type = normaliseType(fields.type, ev);
  if (fields.type && !Object.values(TYPE_ALIASES).flat().includes(fields.type.trim().toLowerCase())) {
    problems.push(`${where} (${fields.date}): didn't recognise the type "${fields.type}", so it's shown as a ${ev.type}.`);
  }
  return { event: ev, unknown, problems };
}

export function parseEvents(text) {
  const events = [];
  const problems = [];
  for (const block of splitBlocks(text)) {
    const result = interpretBlock(block, `The event starting on line ${block.line}`);
    problems.push(...result.problems);
    if (result.event) events.push(result.event);
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  return { events, problems };
}

// ---- Structured editing ----
//
// The card editor works on "items": either an understood event, or a raw block
// of text that couldn't be understood (kept as typed so nothing is lost).

export const EDITABLE_FIELDS = ['date', 'time', 'type', 'kicker', 'title', 'speaker', 'location', 'description', 'note'];
const LABELS = { date: 'Date', time: 'Time', type: 'Type', kicker: 'Intro', title: 'Title', speaker: 'Speaker', location: 'Location', description: 'Description', note: 'Note' };

export function parseToItems(text) {
  const items = splitBlocks(text).map((block) => {
    const { event, unknown } = interpretBlock(block, 'This entry');
    if (!event) return { kind: 'raw', text: block.lines.join('\n') };
    const fields = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, event[f] || '']));
    for (const f of RICH_FIELDS) fields[f] = sanitizeRich(fields[f]);
    return { kind: 'event', fields, extra: unknown };
  });
  // Understood events in date order; anything that needs a look goes first.
  return [
    ...items.filter((i) => i.kind === 'raw'),
    ...items.filter((i) => i.kind === 'event').sort((a, b) => a.fields.date.localeCompare(b.fields.date)),
  ];
}

const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// Turns one item back into a block of text in the events file format.
export function itemToBlock(item) {
  if (item.kind === 'raw') {
    // Kept as typed, minus blank lines (which would split it into two entries).
    return String(item.text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');
  }
  const f = item.fields || {};
  const lines = [];
  for (const field of EDITABLE_FIELDS) {
    let value = oneLine(f[field]);
    if (!value) continue;
    if (field === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) value = value.split('-').reverse().join('/');
    if (field === 'time') value = tidyTime(value);
    if (field === 'type') value = value[0].toUpperCase() + value.slice(1).toLowerCase();
    lines.push(`${LABELS[field]}: ${value}`);
  }
  for (const extra of item.extra || []) if (oneLine(extra)) lines.push(oneLine(extra));
  return lines.join('\n');
}

const FILE_HEADER = `# ------------------------------
#  BECKENHAM & BROMLEY HA — EVENTS PROGRAMME
# ------------------------------
#  This file is normally edited on the website's events editor.
#  Each event is a block of "Label: value" lines, with an
#  empty line between events. Only Date and Title are needed.
# ------------------------------`;

// Events are written in date order; entries that couldn't be understood go first.
export function itemsToText(items) {
  const dateOf = (item) => (item.kind === 'event' && parseDate(oneLine(item.fields?.date))) || '';
  const ordered = [...items].sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
  const blocks = ordered.map(itemToBlock).filter(Boolean);
  return `${FILE_HEADER}\n\n${blocks.join('\n\n')}\n`;
}

// What an item would look like on the site, plus anything wrong with it.
export function checkItem(item) {
  const block = itemToBlock(item);
  if (!block) return { event: null, problems: ['This event is empty. Fill in at least a date and a title, or delete it.'] };
  const { event, problems } = interpretBlock({ line: 1, lines: block.split('\n') }, 'This entry');
  return { event, problems };
}

// Re-reads the file whenever it changes, and keeps serving the last good copy
// if it can't be read at all.
export function createEventsStore(file) {
  let cache = { mtimeMs: -1, events: [], problems: [] };
  return function load() {
    try {
      const { mtimeMs } = fs.statSync(file);
      if (mtimeMs !== cache.mtimeMs) {
        const parsed = parseEvents(fs.readFileSync(file, 'utf8'));
        cache = { mtimeMs, ...parsed };
        parsed.problems.forEach((p) => console.warn(`[events] ${p}`));
      }
    } catch (err) {
      console.error(`[events] Couldn't read ${file}: ${err.message}. Showing the last good programme.`);
      return { ...cache, problems: [...cache.problems, `The events file couldn't be read (${err.code || err.message}). Showing the last version that worked.`] };
    }
    return cache;
  };
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// Adds the display fields the event cards use, and splits into upcoming/past.
export function forDisplay(events, today = new Date().toISOString().slice(0, 10)) {
  const all = events.map((e) => {
    const d = new Date(`${e.date}T12:00:00`);
    return {
      ...e, day: d.getDate(), month: d.toLocaleString('en-GB', { month: 'short' }), year: d.getFullYear(), longDate: dateFmt.format(d),
      descriptionHtml: e.description && renderRich(e.description),
      noteHtml: e.note && renderRich(e.note),
    };
  });
  return { upcoming: all.filter((e) => e.date >= today), past: all.filter((e) => e.date < today) };
}

// ---- The live file, as edited on the website ----

export function versionOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// The live file sits outside the deployed code so deploys never overwrite edits.
// It starts as a copy of the bundled seed file.
export function ensureEventsFile(file, seedFile) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(seedFile, file);
  console.log(`[events] Created ${file} from ${seedFile}`);
}

export class EditConflictError extends Error {}

// Saves atomically (never leaving a half-written file) and records the new
// version in the history.
//  - kind "saved": a normal save from the editor.
//  - kind "restored": putting an older version back. The version being
//    replaced is always backed up first, so a restore can itself be undone.
export function saveEventsFile(file, text, { expectedVersion, history, kind = 'saved', from = null } = {}) {
  const versions = history || createHistory(path.join(path.dirname(file), 'backups'));
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (expectedVersion && versionOf(current) !== expectedVersion) {
    throw new EditConflictError('The events were changed somewhere else since this page was opened.');
  }
  const normalised = `${text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`;
  if (current) {
    if (kind === 'restored') versions.snapshot(current, 'before-restore');
    // The current file may not be in the history yet (e.g. edited by hand, or the very first save).
    else if (!versions.isLatest(current)) versions.snapshot(current, 'earlier');
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, normalised);
  fs.renameSync(tmp, file);
  versions.snapshot(normalised, kind, { from });
  versions.prune();
  return versionOf(normalised);
}
