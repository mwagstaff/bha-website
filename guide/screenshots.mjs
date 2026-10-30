import { chromium } from 'playwright';
const S = process.argv[2], out = (n) => `${S}/shots/${n}.png`;
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1000, height: 2000 }, deviceScaleFactor: 2, colorScheme: 'light' });
const p = await ctx.newPage();
const css = `.masthead{position:absolute!important}[data-bar]{position:static!important}.cookie-box{display:none!important}
 .hl{outline:5px solid #e4002b!important;outline-offset:5px!important;box-shadow:0 0 0 14px rgba(228,0,43,.15)!important}
 *{scroll-behavior:auto!important}`;
const prep = async () => { await p.addStyleTag({ content: css }); };
const hl = (sel) => p.locator(sel).first().evaluate((e) => e.classList.add('hl'));
const unhl = () => p.evaluate(() => document.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl')));
const shot = async (name, sel, pad = 12) => {
  const el = p.locator(sel).first(); await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(250);
  const r = await el.boundingBox();
  await p.screenshot({ path: out(name), clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 } });
};
const shotBetween = async (name, a, z, pad = 24) => {
  const A = p.locator(a).first(); await A.scrollIntoViewIfNeeded(); await p.waitForTimeout(250);
  const ra = await A.boundingBox(), rz = await p.locator(z).first().boundingBox();
  const x = Math.min(ra.x, rz.x) - pad, y = ra.y - pad;
  await p.screenshot({ path: out(name), clip: { x, y, width: Math.max(ra.x + ra.width, rz.x + rz.width) - x + pad, height: rz.y + rz.height - y + pad } });
};

// 1. Login
await p.goto('http://localhost:3099/edit-content'); await prep();
await p.fill('#username', 'Your username');
await p.fill('#password', 'password-goes-here');
await hl('.login-card button[type=submit]');
await shot('01-login', '.login-card');
await p.fill('#username', 'guide'); await p.fill('#password', 'guide-shots-123');
await p.click('.login-card button[type=submit]'); await p.waitForLoadState('networkidle'); await prep();

// 2. Overview of the editor
await p.evaluate(() => scrollTo(0, 0));
await p.screenshot({ path: out('02-editor-top'), clip: { x: 0, y: 0, width: 1000, height: 820 } });

// 3. An event card, with Edit circled
const first = '[data-list=upcoming] > [data-card]:first-child';
await hl(`${first} [data-action=edit]`);
await shot('03-card', first); await unhl();

// 4. The card opened for editing
await p.locator(`${first} [data-action=edit]`).first().click(); await p.waitForTimeout(300);
await shot('04-card-open', first);
await p.locator(`${first} [data-action=edit]`).first().click(); await p.waitForTimeout(300);

// 5. Add an event button
await hl('[data-add]'); await shot('05-add-button', '[data-bar]', 14); await unhl();

// 6. New event filled in
await p.click('[data-add]'); await p.waitForTimeout(400);
const nw = first;
await p.locator(`${nw} [data-field=date]`).fill('2026-12-10');
await p.locator(`${nw} [data-field=time]`).fill('19:00');
await p.locator(`${nw} [data-field=type]`).selectOption('social');
await p.locator(`${nw} [data-field=title]`).fill('Christmas Social Evening');
await p.locator(`${nw} [data-field=description]`).click();
await p.keyboard.type('An evening of festive food, a quiz and a look back at Christmas in old Beckenham.');
await p.locator(`${nw} [data-field=note]`).click();
await p.keyboard.type('Free for members. Please let us know if you are coming.');
await p.locator(`${nw} [data-field=title]`).click(); await p.waitForTimeout(400);
await shot('06-new-event', nw);
await hl(`${nw} [data-action=done]`); await shot('07-done', `${nw} .ecard__form-actions`, 14); await unhl();
await p.locator(`${nw} [data-action=done]`).click(); await p.waitForTimeout(300);
await shot('08-new-closed', nw);

// 9. Unsaved banner + save
await hl('[data-save]'); await shot('09-unsaved', '[data-bar]', 14); await unhl();
await p.click('[data-save]'); await p.waitForTimeout(1200);
await shotBetween('10-saved', '[data-bar]', '[data-notice]', 14);

// 11. Public events page
const ev = await ctx.newPage();
await ev.goto('http://localhost:3099/events'); await ev.addStyleTag({ content: css });
const card = ev.locator('article', { hasText: 'Christmas Social Evening' }).first();
await card.scrollIntoViewIfNeeded(); await ev.waitForTimeout(300);
const r = await card.boundingBox();
await ev.screenshot({ path: out('11-on-website'), clip: { x: r.x - 12, y: r.y - 12, width: r.width + 24, height: r.height + 24 } });
await ev.close();

// 12. Changing one thing: the time
await p.locator(`${first} [data-action=edit]`).first().click(); await p.waitForTimeout(300);
await p.locator(`${first} [data-field=time]`).fill('18:30');
await hl(`${first} [data-field=time]`);
await shot('12-change-time', `${first} .ecard__fields`, 14); await unhl();
await p.locator(`${first} [data-action=done]`).click();
await hl('[data-undo-all]'); await shot('13-undo', '[data-bar]', 14); await unhl();
await p.click('[data-undo-all]'); await p.waitForTimeout(400);

// 14. Duplicate
await hl(`${first} [data-action=duplicate]`); await shot('14-duplicate', first); await unhl();

// 15. Delete confirmation
await p.locator(`${first} [data-action=delete]`).click(); await p.waitForTimeout(300);
await hl(`${first} [data-action=confirm-delete]`); await shot('15-delete', first); await unhl();
await p.locator(`${first} [data-action=cancel-delete]`).click();

// 16. Bold toolbar
await p.locator(`${first} [data-action=edit]`).first().click(); await p.waitForTimeout(300);
await hl(`${first} [data-cmd=bold]`);
await shot('16-toolbar', `${first} .rte`, 20); await unhl();

// 17. Page text editor
await p.goto('http://localhost:3099/edit-content/pages'); await p.waitForLoadState('networkidle'); await prep();
await p.waitForTimeout(800);
await p.evaluate(() => scrollTo(0, document.querySelector('.editor-nav').getBoundingClientRect().top + scrollY - 20));
await p.setViewportSize({ width: 1300, height: 900 }); await p.waitForTimeout(800);
await p.evaluate(() => scrollTo(0, document.querySelector('.editor-nav').getBoundingClientRect().top + scrollY - 20));
await p.screenshot({ path: out('17-pages') });
await p.setViewportSize({ width: 1000, height: 2000 });

// 18. Version history
await p.goto('http://localhost:3099/edit-content/history'); await prep();
await hl('.hcard__restore summary');
await shotBetween('18-history', '.editor-nav', '.history > li:nth-child(2)', 24);
await b.close();
