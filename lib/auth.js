// A shared editor username and password, kept in the BHA_EDITOR_USERNAME and
// BHA_EDITOR_PASSWORD environment variables. Logging in sets a signed cookie;
// changing either logs everyone out. Unless both are set, the editor stays locked.

import crypto from 'node:crypto';

const COOKIE = 'bha_editor';
const MAX_AGE_DAYS = 30;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function sign(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Usernames are matched without regard to capitals or stray spaces; passwords exactly.
const normaliseUsername = (name) => String(name ?? '').trim().toLowerCase();

export function createAuth({
  username = process.env.BHA_EDITOR_USERNAME,
  password = process.env.BHA_EDITOR_PASSWORD,
  cookiePath = '/',
} = {}) {
  const expectedUser = normaliseUsername(username);
  const enabled = Boolean(expectedUser && password && password.length >= 8);
  const key = enabled ? crypto.createHash('sha256').update(`bha-editor-session:${expectedUser}:${password}`).digest() : null;
  const failures = new Map(); // ip -> { count, until }

  return {
    enabled,

    isLoggedIn(req) {
      if (!enabled) return false;
      const raw = readCookie(req, COOKIE);
      if (!raw) return false;
      const [expires, sig] = raw.split('.');
      return Boolean(sig) && Number(expires) > Date.now() && safeEqual(sig, sign(key, expires));
    },

    // Returns 'ok', 'wrong' or 'locked'.
    tryLogin(req, res, { username: givenUser, password: givenPassword } = {}) {
      if (!enabled) return 'wrong';
      // Behind Cloudflare -> Caddy, req.ip is always Caddy's; Cloudflare sets the visitor's address.
      const ip = req.get('cf-connecting-ip') || req.ip;
      const record = failures.get(ip);
      if (record && record.count >= MAX_FAILURES && record.until > Date.now()) return 'locked';
      // Both are always checked, so the time taken doesn't reveal which one was wrong.
      const userOk = safeEqual(normaliseUsername(givenUser), expectedUser);
      const passwordOk = safeEqual(givenPassword || '', password);
      if (!(userOk && passwordOk)) {
        const fresh = !record || record.until <= Date.now();
        failures.set(ip, { count: fresh ? 1 : record.count + 1, until: Date.now() + LOCKOUT_MS });
        return 'wrong';
      }
      failures.delete(ip);
      this.renew(req, res);
      return 'ok';
    },

    // Sets (or extends) the login cookie, so regular use never logs her out.
    renew(req, res) {
      const expires = String(Date.now() + MAX_AGE_DAYS * 864e5);
      res.cookie(COOKIE, `${expires}.${sign(key, expires)}`, {
        httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: MAX_AGE_DAYS * 864e5, path: cookiePath,
      });
    },

    logout(res) {
      res.clearCookie(COOKIE, { path: cookiePath });
    },
  };
}

// Rejects form posts that come from another website.
export function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.get('host')) return res.status(403).send('This request came from another website and was blocked.');
  }
  next();
}
