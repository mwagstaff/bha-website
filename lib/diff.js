// Works out what putting an older version back would do to the events that are
// live now: which events would be added back, removed or changed, and for
// changed ones, exactly which words differ.

import { RICH_FIELDS, richToText, sanitizeRich } from './richtext.js';

export const FIELD_LABELS = {
  date: 'Date', time: 'Time', type: 'Type', kicker: 'Intro', title: 'Title',
  speaker: 'Speaker', location: 'Location', description: 'Description', note: 'Note',
};
const FIELDS = Object.keys(FIELD_LABELS);
const TYPE_NAMES = { lecture: 'Lecture', visit: 'Visit', social: 'Social' };
const longDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// How a field reads to a person (dates written out, types capitalised, formatting as plain words).
export function readable(field, value) {
  if (!value) return '';
  if (field === 'date') return longDate.format(new Date(`${value}T12:00:00Z`)).replace(',', '');
  if (field === 'type') return TYPE_NAMES[value] || value;
  if (RICH_FIELDS.includes(field)) return richToText(value);
  return String(value);
}

// Splits text into words and the spaces between them, then finds the longest
// common run so only real differences are marked.
export function wordDiff(before, after) {
  const a = before.match(/\s+|[^\s]+/g) || [];
  const b = after.match(/\s+|[^\s]+/g) || [];
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const parts = [];
  const push = (type, text) => {
    const last = parts.at(-1);
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push('same', a[i]); i++; j++; } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) { push('added', b[j]); j++; } else { push('removed', a[i]); i++; }
  }
  // Several changed words in a row (with only spaces between them) read better
  // as one highlighted phrase than as a box around each word.
  const grouped = [];
  for (let k = 0; k < parts.length; k++) {
    const isChange = (p) => p && p.type !== 'same';
    const isGap = (p) => p && p.type === 'same' && !p.text.trim();
    if (!isChange(parts[k])) { grouped.push(parts[k]); continue; }
    let removed = '';
    let added = '';
    while (isChange(parts[k]) || (isGap(parts[k]) && isChange(parts[k + 1]))) {
      const p = parts[k];
      if (p.type !== 'added') removed += p.text; // removed words, and the gaps between
      if (p.type !== 'removed') added += p.text; // added words, and the gaps between
      k++;
    }
    k--;
    if (removed) grouped.push({ type: 'removed', text: removed });
    if (added) grouped.push({ type: 'added', text: added });
  }
  // Spaces at the edges of a change aren't highlighted (a highlighted space looks like a stray mark).
  return grouped.flatMap((p) => {
    if (p.type === 'same') return [p];
    const [, lead, core, trail] = p.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return [
      lead && { type: `${p.type}-space`, text: lead },
      core && { type: p.type, text: core },
      trail && { type: `${p.type}-space`, text: trail },
    ].filter(Boolean);
  });
}

function fieldChanges(now, then) {
  const changes = [];
  for (const field of FIELDS) {
    const a = now[field] || '';
    const b = then[field] || '';
    if (a === b) continue;
    const textA = readable(field, a);
    const textB = readable(field, b);
    const rich = RICH_FIELDS.includes(field);
    changes.push({
      field, label: FIELD_LABELS[field],
      parts: wordDiff(textA, textB),
      // The words are the same but bold/italic/links differ: show both, formatted.
      formattingOnly: rich && textA === textB,
      nowHtml: rich ? sanitizeRich(a) : null,
      thenHtml: rich ? sanitizeRich(b) : null,
    });
  }
  return changes;
}

function details(event) {
  return FIELDS.filter((f) => event[f]).map((field) => ({
    field, label: FIELD_LABELS[field],
    text: readable(field, event[field]),
    html: RICH_FIELDS.includes(field) ? sanitizeRich(event[field]) : null,
  }));
}

// Pairs events between the two versions: first by date and title, then
// (for what's left) by date alone, then by title alone, so a renamed or
// moved event shows as one change rather than a removal plus an addition.
export function diffEvents(liveEvents, versionEvents) {
  const live = [...liveEvents];
  const then = [...versionEvents];
  const pairs = [];
  const matchBy = (sameKey) => {
    for (let i = 0; i < then.length; i++) {
      const j = live.findIndex((e) => sameKey(e, then[i]));
      if (j !== -1) { pairs.push([live[j], then[i]]); live.splice(j, 1); then.splice(i, 1); i--; }
    }
  };
  matchBy((a, b) => a.date === b.date && a.title === b.title);
  // Only when that day has a single event in both versions, so two events on one day are never guessed at.
  const onDay = (list, date) => list.filter((e) => e.date === date).length;
  matchBy((a, b) => a.date === b.date && onDay(liveEvents, a.date) === 1 && onDay(versionEvents, b.date) === 1);
  matchBy((a, b) => a.title === b.title);

  const heading = (e) => ({ title: e.title, date: readable('date', e.date), iso: e.date });
  const changed = pairs
    .map(([now, past]) => ({ ...heading(past), changes: fieldChanges(now, past) }))
    .filter((c) => c.changes.length);
  const byDate = (x, y) => x.iso.localeCompare(y.iso);
  return {
    added: then.map((e) => ({ ...heading(e), details: details(e) })).sort(byDate),
    removed: live.map((e) => ({ ...heading(e), details: details(e) })).sort(byDate),
    changed: changed.sort(byDate),
    unchanged: pairs.length - changed.length,
    total: versionEvents.length,
  };
}
