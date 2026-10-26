// Page text editor: one tab per page, a field per section, a live preview of
// the real page, and one Save for everything.
import { setupRichEditor } from './rich-editor.js';

const root = document.querySelector('[data-pages-editor]');
const base = root.dataset.base;
const data = JSON.parse(document.getElementById('editor-data').textContent);
const bar = root.querySelector('[data-bar]');
const banner = root.querySelector('[data-unsaved-banner]');
const bannerDetail = root.querySelector('[data-unsaved-detail]');
const statusEl = root.querySelector('[data-status]');
const saveBtn = root.querySelector('[data-save]');
const undoBtn = root.querySelector('[data-undo-all]');
const noticeEl = root.querySelector('[data-notice]');
const frame = root.querySelector('[data-frame]');
const frameWrap = root.querySelector('[data-frame-wrap]');
const openPage = root.querySelector('[data-open-page]');
const linkTemplate = document.getElementById('tpl-link');

const sections = data.sections;
const pageOf = Object.fromEntries(sections.map((s) => [s.id, s.page]));
const clone = (v) => JSON.parse(JSON.stringify(v));
let version = data.version;
let saved = clone(data.values);
let values = clone(data.values);
let current = null;
let saving = false;
const fields = new Map(); // section id -> { set(value) }

// ---- Unsaved changes ----

const changedIds = () => sections.filter((s) => JSON.stringify(values[s.id]) !== JSON.stringify(saved[s.id])).map((s) => s.id);
const isDirty = () => changedIds().length > 0;

function updateStatus(text) {
  const changed = changedIds();
  const dirty = changed.length > 0;
  const pagesChanged = [...new Set(changed.map((id) => pageOf[id]))];
  const labels = pagesChanged.map((id) => data.pages.find((p) => p.id === id).label);
  statusEl.textContent = text || (dirty ? 'Unsaved changes' : 'No unsaved changes');
  bar.classList.toggle('editor__bar--unsaved', dirty);
  banner.hidden = !dirty;
  bannerDetail.textContent = dirty ? `(on ${labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0]})` : '';
  saveBtn.disabled = !dirty || saving;
  undoBtn.hidden = !dirty;
  for (const tab of root.querySelectorAll('[data-page-tab]')) {
    tab.querySelector('[data-page-dot]').hidden = !pagesChanged.includes(tab.dataset.pageTab);
  }
}

// ---- Fields ----

function setupField(card) {
  const id = card.dataset.section;
  const kind = card.dataset.kind;
  if (kind === 'rich') {
    const editor = setupRichEditor(card.querySelector('[data-rich]'), {
      value: values[id],
      onChange: (html) => { values[id] = html; changed(); },
    });
    fields.set(id, { set: (v) => editor.set(v) });
  } else if (kind === 'links') {
    setupLinks(card, id);
  } else {
    const input = card.querySelector('[data-input]');
    input.value = values[id];
    input.addEventListener('input', () => { values[id] = input.value; changed(); });
    fields.set(id, { set: (v) => { input.value = v; } });
  }
}

function setupLinks(card, id) {
  const list = card.querySelector('[data-links]');
  const render = () => {
    list.replaceChildren(...values[id].map((link, i) => {
      const row = linkTemplate.content.firstElementChild.cloneNode(true);
      for (const input of row.querySelectorAll('[data-link-field]')) {
        input.value = link[input.dataset.linkField] || '';
        input.addEventListener('input', () => { values[id][i][input.dataset.linkField] = input.value; changed(); });
      }
      row.querySelector('[data-move="-1"]').disabled = i === 0;
      row.querySelector('[data-move="1"]').disabled = i === values[id].length - 1;
      for (const btn of row.querySelectorAll('[data-move]')) {
        btn.addEventListener('click', () => {
          const j = i + Number(btn.dataset.move);
          [values[id][i], values[id][j]] = [values[id][j], values[id][i]];
          render();
          changed();
          list.children[j]?.querySelector(`[data-move="${btn.dataset.move}"]`)?.focus();
        });
      }
      const confirm = row.querySelector('[data-confirm]');
      const remove = row.querySelector('[data-remove]');
      remove.addEventListener('click', () => { confirm.hidden = false; remove.hidden = true; });
      row.querySelector('[data-cancel-remove]').addEventListener('click', () => { confirm.hidden = true; remove.hidden = false; });
      row.querySelector('[data-confirm-remove]').addEventListener('click', () => { values[id].splice(i, 1); render(); changed(); });
      return row;
    }));
  };
  card.querySelector('[data-add-link]').addEventListener('click', () => {
    values[id].push({ name: '', url: '', description: '' });
    render();
    changed();
    list.lastElementChild.querySelector('input').focus();
  });
  render();
  fields.set(id, { set: render });
}

root.querySelectorAll('[data-section]').forEach(setupField);

function showProblems(problems = {}) {
  for (const card of root.querySelectorAll('[data-section]')) {
    const p = card.querySelector('[data-problem]');
    p.textContent = problems[card.dataset.section] || '';
    p.hidden = !problems[card.dataset.section];
  }
}

// ---- Pages and preview ----

function showPage(id) {
  current = id;
  for (const tab of root.querySelectorAll('[data-page-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.pageTab === id));
  for (const card of root.querySelectorAll('[data-section]')) card.hidden = card.dataset.page !== id;
  openPage.href = data.pages.find((p) => p.id === id).path;
  const url = new URL(location.href);
  url.searchParams.set('page', id);
  history.replaceState(null, '', url);
  preview();
}

root.querySelectorAll('[data-page-tab]').forEach((tab) => tab.addEventListener('click', () => showPage(tab.dataset.pageTab)));

let timer = null;
let requestId = 0;

function changed() {
  updateStatus();
  clearTimeout(timer);
  timer = setTimeout(preview, 500);
}

async function preview() {
  const id = ++requestId;
  try {
    const res = await post(`${base}/pages/preview`, { page: current, values });
    if (id !== requestId) return; // a newer preview is on its way
    frame.srcdoc = res.html;
    showProblems(res.problems);
  } catch (err) {
    if (err.status === 401) loggedOut();
  }
}

// The preview shows the page at computer width, scaled down to fit (on a
// phone or small tablet, where the preview sits under the fields, it shows
// the page as it looks on that device). The frame never runs the page's scripts.
function fitFrame() {
  const width = frameWrap.clientWidth;
  if (window.innerWidth < 1000) {
    Object.assign(frame.style, { width: '100%', height: '75vh', transform: 'none' });
    return;
  }
  const scale = width / 1200;
  Object.assign(frame.style, { width: '1200px', height: `${frameWrap.clientHeight / scale}px`, transform: `scale(${scale})` });
}
new ResizeObserver(fitFrame).observe(frameWrap);
window.addEventListener('resize', fitFrame);
fitFrame();

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

function setAll() {
  for (const s of sections) fields.get(s.id)?.set(values[s.id]);
}

async function save() {
  if (saving || !isDirty()) return;
  saving = true;
  updateStatus('Saving…');
  try {
    const res = await post(`${base}/pages`, { version, values });
    version = res.version;
    saved = clone(res.values);
    values = clone(res.values);
    setAll();
    saving = false;
    updateStatus('All changes saved');
    showProblems(res.problems);
    const problemPages = [...new Set(Object.keys(res.problems || {}).map((id) => data.pages.find((p) => p.id === pageOf[id]).label))];
    notice('ok', problemPages.length
      ? `Saved, but something couldn't be used: see the message in yellow on the ${problemPages.join(' and ')} ${problemPages.length > 1 ? 'pages' : 'page'}.`
      : 'Saved. The website has been updated.',
    { href: openPage.href, text: 'View the page' });
    preview();
  } catch (err) {
    saving = false;
    updateStatus();
    if (err.status === 401) loggedOut();
    else notice('error', err.message);
  }
}

function loggedOut() {
  notice('error', "You've been logged out, so your changes haven't been saved yet. They're still here: log in again in a new tab, then come back and press Save changes.",
    { href: `${base}/login`, text: 'Log in (opens a new tab)', newTab: true });
}

function notice(kind, message, link) {
  const box = document.createElement('div');
  box.className = `notice${kind === 'error' ? ' notice--error' : ''}`;
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  box.append(message);
  if (link) {
    const a = Object.assign(document.createElement('a'), { href: link.href, textContent: link.text, target: '_blank', rel: 'noopener' });
    box.append(' ', a);
  }
  noticeEl.replaceChildren(box);
}

undoBtn.addEventListener('click', () => {
  values = clone(saved);
  setAll();
  updateStatus();
  showProblems();
  notice('info', 'All unsaved changes have been undone.');
  preview();
});
saveBtn.addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});
window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

const requested = new URL(location.href).searchParams.get('page');
showPage(data.pages.some((p) => p.id === requested) ? requested : data.pages[0].id);
updateStatus();
