// A very small formatting editor: bold, italic, underline and links, on a
// contenteditable box. The server sanitises whatever it produces.

let nextId = 1;

// Turns what people type into a working link address.
export function normaliseLink(raw) {
  const text = raw.trim();
  if (!text) return '';
  if (/^(https?:|mailto:)/i.test(text)) return text;
  if (/^\/(?!\/)/.test(text)) return text; // a page on this site, e.g. /events
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(text)) return `mailto:${text}`;
  return `https://${text.replace(/^\/+/, '')}`;
}

function linkAround(node, area) {
  for (let n = node; n && n !== area; n = n.parentNode) if (n.nodeName === 'A') return n;
  return null;
}

// root: the [data-rich] element; onChange(html) is called after every edit.
export function setupRichEditor(root, { value = '', onChange }) {
  const area = root.querySelector('[contenteditable]');
  const label = root.querySelector('[data-rich-label]');
  const panel = root.querySelector('[data-link-panel]');
  const linkInput = root.querySelector('[data-link-input]');
  const hint = root.querySelector('[data-rich-hint]');
  const buttons = [...root.querySelectorAll('[data-cmd]')];
  let savedRange = null;

  label.id = `rte-label-${nextId++}`;
  area.setAttribute('aria-labelledby', label.id);
  area.innerHTML = value;

  const read = () => (area.textContent.trim() || area.querySelector('a') ? area.innerHTML : '');
  const changed = () => { onChange(read()); updateButtons(); };

  function inArea(range) {
    return range && area.contains(range.commonAncestorContainer);
  }

  function currentRange() {
    const sel = window.getSelection();
    return sel.rangeCount && inArea(sel.getRangeAt(0)) ? sel.getRangeAt(0) : null;
  }

  function restore(range) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function say(message) {
    hint.textContent = message;
    hint.hidden = !message;
  }

  function updateButtons() {
    const active = Boolean(currentRange());
    for (const btn of buttons) {
      if (['bold', 'italic', 'underline'].includes(btn.dataset.cmd)) {
        btn.setAttribute('aria-pressed', String(active && document.queryCommandState(btn.dataset.cmd)));
      }
    }
  }

  function openLinkPanel() {
    const range = currentRange();
    const existing = range && linkAround(range.startContainer, area);
    if (!range || (range.collapsed && !existing)) {
      say('First select the words you want to turn into a link, then press Link.');
      area.focus();
      return;
    }
    if (existing && range.collapsed) {
      // Editing an existing link: select the whole link.
      const whole = document.createRange();
      whole.selectNodeContents(existing);
      restore(whole);
    }
    savedRange = currentRange().cloneRange();
    linkInput.value = existing ? existing.getAttribute('href').replace(/^mailto:/, '') : '';
    say('');
    panel.hidden = false;
    linkInput.focus();
  }

  function closeLinkPanel() {
    panel.hidden = true;
    savedRange = null;
  }

  function applyLink() {
    const url = normaliseLink(linkInput.value);
    if (!url) { linkInput.focus(); return; }
    area.focus();
    if (savedRange) restore(savedRange);
    document.execCommand('createLink', false, url);
    closeLinkPanel();
    changed();
  }

  function removeLink() {
    const range = currentRange();
    const existing = range && linkAround(range.startContainer, area);
    if (!range || (!existing && range.collapsed)) {
      say('Click on a link first, then press Remove link.');
      return;
    }
    if (existing && range.collapsed) {
      const whole = document.createRange();
      whole.selectNodeContents(existing);
      restore(whole);
    }
    document.execCommand('unlink');
    say('');
    changed();
  }

  for (const btn of buttons) {
    // Keep the text selection when a toolbar button is pressed.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      if (cmd === 'link') return openLinkPanel();
      if (cmd === 'unlink') return removeLink();
      if (!currentRange()) area.focus();
      document.execCommand('styleWithCSS', false, false);
      document.execCommand(cmd);
      say('');
      changed();
    });
  }

  root.querySelector('[data-link-apply]').addEventListener('click', applyLink);
  root.querySelector('[data-link-cancel]').addEventListener('click', () => { closeLinkPanel(); area.focus(); });
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
    if (e.key === 'Escape') { e.preventDefault(); closeLinkPanel(); area.focus(); }
  });

  area.addEventListener('input', changed);
  area.addEventListener('keyup', updateButtons);
  area.addEventListener('mouseup', updateButtons);
  // Enter makes a simple line break rather than a new paragraph.
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && document.execCommand('insertLineBreak')) e.preventDefault();
  });
  // Pasted text arrives without its original fonts and colours.
  area.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    document.execCommand('insertText', false, text);
  });

  return { set(html) { area.innerHTML = html; } };
}
