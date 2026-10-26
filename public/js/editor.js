// Events editor: one card per event, with live previews, saved as a whole.
import { setupRichEditor } from './rich-editor.js';

const root = document.querySelector('[data-editor]');
const data = JSON.parse(document.getElementById('editor-data').textContent);
const base = root.dataset.base; // the editor's address, e.g. /edit-content
const tplEvent = document.getElementById('tpl-event');
const tplRaw = document.getElementById('tpl-raw');
const statusEl = root.querySelector('[data-status]');
const bar = root.querySelector('[data-bar]');
const banner = root.querySelector('[data-unsaved-banner]');
const bannerDetail = root.querySelector('[data-unsaved-detail]');
const saveBtn = root.querySelector('[data-save]');
const undoBtn = root.querySelector('[data-undo-all]');
const noticeEl = root.querySelector('[data-notice]');
const lists = Object.fromEntries([...root.querySelectorAll('[data-list]')].map((el) => [el.dataset.list, el]));
const FIELDS = ['date', 'time', 'type', 'kicker', 'title', 'speaker', 'location', 'description', 'note'];

let version = data.version;
let lastSaved = data.items; // as the server last sent them, for "Undo all changes"
let items = [];
let savedSnapshot = '';
let originals = new Map(); // id -> what the item was when last saved
let nextId = 1;
let saving = false;

// ---- State ----

const serial = (item) => (item.kind === 'raw'
  ? { kind: 'raw', text: item.text }
  : { kind: 'event', fields: { ...item.fields }, extra: item.extra || [] });

function load(fromServer) {
  // Copies, so editing never changes `lastSaved` (which "Undo all changes" restores).
  items = fromServer.map((it) => ({ ...it, fields: it.fields && { ...it.fields }, extra: [...(it.extra || [])], id: nextId++ }));
  originals = new Map(items.map((it) => [it.id, JSON.stringify(serial(it))]));
  savedSnapshot = JSON.stringify(items.map(serial));
  render();
  updateStatus();
}

const isDirty = () => JSON.stringify(items.map(serial)) !== savedSnapshot;
const isChanged = (item) => originals.get(item.id) !== JSON.stringify(serial(item));

function updateStatus(text) {
  const dirty = isDirty();
  const added = items.filter((i) => !originals.has(i.id)).length;
  const changed = items.filter((i) => originals.has(i.id) && isChanged(i)).length;
  const removed = [...originals.keys()].filter((id) => !items.some((i) => i.id === id)).length;
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (changed) parts.push(`${changed} changed`);
  if (removed) parts.push(`${removed} deleted`);
  statusEl.textContent = text || (dirty ? `Unsaved: ${parts.join(', ') || 'changes'}` : 'No unsaved changes');
  statusEl.dataset.tone = dirty ? 'warn' : '';
  // The sticky bar turns into a banner while anything is unsaved.
  bar.classList.toggle('editor__bar--unsaved', dirty);
  banner.hidden = !dirty;
  bannerDetail.textContent = parts.length ? `(${parts.join(', ')})` : '';
  saveBtn.disabled = !dirty || saving;
  undoBtn.hidden = !dirty;
  items.forEach((item) => { if (item.el) item.el.querySelector('[data-badge]').hidden = !isChanged(item); });
}

// ---- Rendering ----

function groupOf(item) {
  if (item.kind === 'raw' || !item.html) return item.isNew ? 'upcoming' : 'attention';
  return item.past ? 'past' : 'upcoming';
}

function render() {
  Object.values(lists).forEach((l) => l.replaceChildren());
  for (const item of items) {
    item.el = item.kind === 'raw' ? rawCard(item) : eventCard(item);
    lists[groupOf(item)].append(item.el);
  }
  refreshGroups();
}

function refreshGroups() {
  for (const [name, list] of Object.entries(lists)) {
    const count = list.children.length;
    const counter = root.querySelector(`[data-count="${name}"]`);
    if (counter) counter.textContent = `(${count})`;
    if (name === 'attention') list.closest('[data-group]').hidden = count === 0;
  }
}

function showProblems(item) {
  const ul = item.el.querySelector('[data-problems]');
  ul.replaceChildren(...(item.problems || []).map((p) => Object.assign(document.createElement('li'), { textContent: p })));
  ul.hidden = !(item.problems || []).length;
}

function showPreview(item) {
  const box = item.el.querySelector('[data-preview]');
  if (item.html) {
    box.innerHTML = item.html; // rendered and escaped by the server's event-card template
  } else {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'ecard__placeholder',
      textContent: item.isNew ? 'New event: fill in the details below.' : 'This event is not on the website yet (see below).',
    }));
  }
}

function eventCard(item) {
  const el = tplEvent.content.firstElementChild.cloneNode(true);
  item.el = el;
  for (const field of FIELDS) {
    const input = el.querySelector(`[data-field="${field}"]`);
    if (input.isContentEditable) {
      setupRichEditor(input.closest('[data-rich]'), {
        value: item.fields[field] || '',
        onChange: (html) => { item.fields[field] = html; changed(item); },
      });
      continue;
    }
    input.value = item.fields[field] || '';
    if (field === 'type' && !input.value) input.value = 'lecture';
    input.addEventListener('input', () => {
      item.fields[field] = input.value;
      changed(item);
    });
  }
  showPreview(item);
  showProblems(item);
  wireCommon(item);
  el.querySelector('[data-action="edit"]').addEventListener('click', () => setOpen(item, el.querySelector('[data-form]').hidden));
  el.querySelector('[data-action="done"]').addEventListener('click', () => setOpen(item, false));
  el.querySelector('[data-action="duplicate"]').addEventListener('click', () => duplicate(item));
  return el;
}

function rawCard(item) {
  const el = tplRaw.content.firstElementChild.cloneNode(true);
  item.el = el;
  const textarea = el.querySelector('[data-raw]');
  textarea.value = item.text;
  textarea.addEventListener('input', () => {
    item.text = textarea.value;
    changed(item);
  });
  showProblems(item);
  wireCommon(item);
  return el;
}

function wireCommon(item) {
  const { el } = item;
  const confirm = el.querySelector('[data-confirm]');
  const del = el.querySelector('[data-action="delete"]');
  del.addEventListener('click', () => { confirm.hidden = false; del.hidden = true; });
  el.querySelector('[data-action="cancel-delete"]').addEventListener('click', () => { confirm.hidden = true; del.hidden = false; });
  el.querySelector('[data-action="confirm-delete"]').addEventListener('click', () => remove(item));
}

function setOpen(item, open) {
  const form = item.el.querySelector('[data-form]');
  const btn = item.el.querySelector('[data-action="edit"]');
  form.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? 'Close' : 'Edit';
  item.el.classList.toggle('ecard--open', open);
  if (!open) item.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---- Editing ----

const timers = new Map();
const sequence = new Map();

function changed(item) {
  updateStatus();
  clearTimeout(timers.get(item.id));
  timers.set(item.id, setTimeout(() => preview(item), 350));
}

async function preview(item) {
  const seq = (sequence.get(item.id) || 0) + 1;
  sequence.set(item.id, seq);
  try {
    const res = await post(`${base}/events/preview`, { items: [serial(item)] });
    if (sequence.get(item.id) !== seq || !items.includes(item)) return; // superseded
    const [result] = res.items;
    Object.assign(item, { html: result.html, problems: result.problems, past: result.past });
    if (item.kind === 'raw') {
      item.el.querySelector('[data-raw-ok]').hidden = !result.html;
      item.el.querySelector('[data-problems]').hidden = Boolean(result.html) || !result.problems.length;
      if (!result.html) showProblems(item);
    } else {
      showPreview(item);
      showProblems(item);
    }
  } catch (err) {
    if (err.status === 401) loggedOut();
  }
}

function blankEvent() {
  return { kind: 'event', fields: Object.fromEntries(FIELDS.map((f) => [f, ''])), extra: [], html: null, problems: [], isNew: true };
}

function insertNew(item, after) {
  item.id = nextId++;
  if (after) {
    items.splice(items.indexOf(after) + 1, 0, item);
    after.el.after(eventCard(item));
  } else {
    items.unshift(item);
    lists.upcoming.prepend(eventCard(item));
  }
  refreshGroups();
  setOpen(item, true);
  item.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  item.el.querySelector('[data-field="date"]').focus({ preventScroll: true });
  updateStatus();
}

root.querySelector('[data-add]').addEventListener('click', () => {
  const item = blankEvent();
  Object.assign(item.fields, { time: '19:30', type: 'lecture' });
  insertNew(item);
});

function duplicate(source) {
  const item = blankEvent();
  Object.assign(item.fields, source.fields);
  item.html = source.html;
  insertNew(item, source);
  preview(item);
}

function remove(item) {
  items = items.filter((i) => i !== item);
  item.el.remove();
  refreshGroups();
  updateStatus();
}

undoBtn.addEventListener('click', () => {
  load(lastSaved);
  notice('info', 'All unsaved changes have been undone.');
});

// ---- Saving ----

class RequestError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new RequestError(json.error || 'Something went wrong.', res.status);
  return json;
}

async function save() {
  if (saving || !isDirty()) return;
  saving = true;
  updateStatus('Saving…');
  try {
    const res = await post(`${base}/events`, { version, items: items.map(serial) });
    version = res.version;
    lastSaved = res.items;
    saving = false;
    load(res.items);
    notice('ok', 'Saved. The events page has been updated.', { href: '/events', text: 'View it' });
    updateStatus('All changes saved');
  } catch (err) {
    saving = false;
    updateStatus();
    if (err.status === 401) loggedOut();
    else notice('error', err.message);
  }
}

function loggedOut() {
  notice('error', "You've been logged out, so your changes haven't been saved yet. They're still here: log in again in a new tab, then come back and click Save changes.",
    { href: `${base}/login`, text: 'Log in (opens a new tab)', newTab: true });
}

function notice(kind, message, link) {
  const box = document.createElement('div');
  box.className = `notice${kind === 'error' ? ' notice--error' : ''}`;
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  box.append(message);
  if (link) {
    const a = Object.assign(document.createElement('a'), { href: link.href, textContent: link.text });
    if (link.newTab) Object.assign(a, { target: '_blank', rel: 'noopener' });
    box.append(' ', a);
  }
  noticeEl.replaceChildren(box);
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

saveBtn.addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});
window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

load(data.items);
