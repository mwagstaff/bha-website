// Basic formatting (bold, italic, underline, links, line breaks) for the
// Description and Note fields. It is stored as a tiny subset of HTML in the
// events file and always passed through an allowlist before use, so nothing
// else (scripts, styles, pasted Word formatting) can reach the public site.

import sanitizeHtml from 'sanitize-html';

export const RICH_FIELDS = ['description', 'note'];
const MAX_LENGTH = 5000;

const OPTIONS = {
  allowedTags: ['b', 'strong', 'i', 'em', 'u', 'a', 'br'],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: { strong: 'b', em: 'i' },
};

// Returns safe HTML. Plain text (including hand-typed "&" or "<") comes out correctly escaped.
export function sanitizeRich(value) {
  const html = String(value ?? '')
    .slice(0, MAX_LENGTH)
    // Paragraphs and divs from the browser's editor become line breaks.
    // (A new block starts a new line; leading breaks are trimmed below.)
    .replace(/<(p|div)(\s[^>]*)?>/gi, '<br>')
    .replace(/<\/(p|div)\s*>/gi, '')
    .replace(/\r?\n/g, '<br>');
  return sanitizeHtml(html, OPTIONS)
    .replace(/<br \/>/g, '<br>')
    .replace(/<a(?![^>]*href)[^>]*>(.*?)<\/a>/gi, '$1') // a link with no usable address is just text
    .replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>')
    .replace(/^(\s|&nbsp;|<br\s*\/?>)+|(\s|&nbsp;|<br\s*\/?>)+$/gi, '');
}

// For showing on the website: links to other websites open in a new tab, so
// visitors don't lose their place; links to this site's own pages don't.
export function renderRich(value) {
  return sanitizeRich(value).replace(/<a href="(https?:)/g, '<a target="_blank" rel="noopener noreferrer" href="$1');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

// Plain text for places that can't show formatting, such as calendar apps.
export function richToText(value) {
  const html = sanitizeRich(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (m, href, text) => {
      const url = decodeEntities(href).replace(/^mailto:/, '');
      const label = decodeEntities(text.replace(/<[^>]+>/g, ''));
      return label && label !== url ? `${label} (${url})` : url;
    });
  return decodeEntities(html.replace(/<[^>]+>/g, ''));
}
