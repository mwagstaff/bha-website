import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRich, renderRich, richToText } from '../lib/richtext.js';

test('keeps bold, italic, underline, links and line breaks', () => {
  assert.equal(sanitizeRich('<b>B</b> <strong>S</strong> <i>I</i> <em>E</em> <u>U</u>'), '<b>B</b> <b>S</b> <i>I</i> <i>E</i> <u>U</u>');
  assert.equal(sanitizeRich('<a href="https://x.org">x</a> <a href="mailto:a@b.co">a</a>'), '<a href="https://x.org">x</a> <a href="mailto:a@b.co">a</a>');
  assert.equal(sanitizeRich('one<div>two</div><p>three</p>'), 'one<br>two<br>three');
  assert.equal(sanitizeRich('a\nb'), 'a<br>b');
  assert.equal(sanitizeRich('<div>a</div><div><br></div><div>b</div>'), 'a<br><br>b', 'an empty line typed in the editor is kept');
});

test('removes anything that could be harmful', () => {
  const attacks = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>',
    '<a href="javascript:alert(1)">x</a>', '<a href="&#106;avascript:alert(1)">x</a>', '<a href=" javascript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>', '<a href="//evil.example">x</a>',
    '<b onclick="alert(1)">x</b>', '<iframe src="https://evil.example"></iframe>', '<style>body{display:none}</style>',
    '<a href="https://ok.example" style="position:fixed" target="_top">x</a>', '<!--<script>alert(1)</script>-->',
  ];
  for (const attack of attacks) {
    const out = sanitizeRich(attack);
    assert.doesNotMatch(out, /<script|<img|<svg|<iframe|<style|on\w+=|javascript:|data:|style=|target=|\/\/evil/i, `${attack} -> ${out}`);
  }
});

test('plain text with & and < is escaped, and sanitising twice changes nothing', () => {
  for (const input of ['Fish & Chips < £5', '<b>Tea</b> &amp; cake', 'a<br><br><br><br>b', 'Line\nbreak', '<a href="https://x.org/?a=1&b=2">q</a>']) {
    const once = sanitizeRich(input);
    assert.equal(sanitizeRich(once), once, input);
  }
  assert.equal(sanitizeRich('Fish & Chips < £5'), 'Fish &amp; Chips &lt; £5');
});

test('links on the website open in a new tab', () => {
  assert.equal(renderRich('<a href="https://x.org">x</a>'), '<a target="_blank" rel="noopener noreferrer" href="https://x.org">x</a>');
});

test('calendar text has no tags, and shows link addresses', () => {
  assert.equal(richToText('<b>Book</b> &amp; pay <a href="https://x.org">here</a><br>or <a href="mailto:a@b.co">a@b.co</a>'), 'Book & pay here (https://x.org)\nor a@b.co');
});
