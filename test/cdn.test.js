import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCachePurger } from '../lib/cdn.js';

const ZONES = { 'beckenham-historical-association.org': 'zone-bha', 'skynolimit.dev': 'zone-sky' };
const quiet = { log: () => {}, error: () => {} };

// A pretend Cloudflare API that records what it was asked.
function fakeCloudflare({ fail = false, refuseHosts = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body && JSON.parse(options.body);
    calls.push({ url, method: options.method || 'GET', body, auth: options.headers.authorization });
    if (fail) return new Response('{"success":false,"errors":[{"message":"Authentication error"}]}', { status: 403 });
    if (refuseHosts && body?.hosts) return new Response('{"success":false,"errors":[{"message":"Not allowed"}]}', { status: 400 });
    const name = new URL(url).searchParams.get('name');
    const result = name ? (ZONES[name] ? [{ id: ZONES[name] }] : []) : { id: 'purged' };
    return new Response(JSON.stringify({ success: true, result }));
  };
  return { calls, fetchImpl };
}

const env = { CLOUDFLARE_PURGE_TOKEN: 'test-token', BHA_PUBLIC_HOSTS: 'beckenham-historical-association.org, www.beckenham-historical-association.org,bha.skynolimit.dev' };

test('without a token or hosts nothing is cleared', async () => {
  const { calls, fetchImpl } = fakeCloudflare();
  for (const e of [{}, { CLOUDFLARE_PURGE_TOKEN: 'x' }, { BHA_PUBLIC_HOSTS: 'a.org' }]) {
    const cdn = createCachePurger({ env: e, paths: ['/'], fetchImpl });
    assert.equal(cdn.enabled, false);
    assert.equal(await cdn.purge(), false);
  }
  assert.equal(calls.length, 0);
});

test("clears everything cached for each of the site's hostnames, in its zone", async () => {
  const { calls, fetchImpl } = fakeCloudflare();
  const cdn = createCachePurger({ env, paths: ['/', '/events'], fetchImpl, log: quiet });
  assert.equal(await cdn.purge(), true);
  const purges = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(purges.map((c) => [c.url.match(/zones\/([^/]+)/)[1], c.body]), [
    ['zone-bha', { hosts: ['beckenham-historical-association.org'] }],
    ['zone-bha', { hosts: ['www.beckenham-historical-association.org'] }],
    ['zone-sky', { hosts: ['bha.skynolimit.dev'] }],
  ]);
  assert.ok(calls.every((c) => c.auth === 'Bearer test-token'));

  // Zones are only looked up the first time.
  const lookups = calls.length - purges.length;
  await cdn.purge();
  assert.equal(calls.length - lookups, purges.length * 2);
});

test("if Cloudflare won't clear a hostname, its pages are cleared one by one, at most 30 per request", async () => {
  const { calls, fetchImpl } = fakeCloudflare({ refuseHosts: true });
  const paths = Array.from({ length: 40 }, (_, i) => `/p${i}`);
  const cdn = createCachePurger({ env: { ...env, BHA_PUBLIC_HOSTS: 'beckenham-historical-association.org' }, paths, fetchImpl, log: quiet });
  assert.equal(await cdn.purge(), true);
  const purges = calls.filter((c) => c.method === 'POST').map((c) => c.body);
  assert.deepEqual(purges[0], { hosts: ['beckenham-historical-association.org'] });
  assert.deepEqual(purges.slice(1).map((b) => b.files.length), [30, 10]);
  assert.equal(purges[1].files[0], 'https://beckenham-historical-association.org/p0');
});

test("an address whose zone the token can't see doesn't stop the others being cleared", async () => {
  const { calls, fetchImpl } = fakeCloudflare();
  const messages = { log: [], error: [] };
  const cdn = createCachePurger({ env: { ...env, BHA_PUBLIC_HOSTS: 'beckenham-historical-association.org,bha.unknown.example' }, paths: ['/'], fetchImpl,
    log: { log: (m) => messages.log.push(m), error: (m) => messages.error.push(m) } });
  assert.equal(await cdn.purge(), false);
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body), [{ hosts: ['beckenham-historical-association.org'] }]);
  assert.match(messages.log[0], /Cleared .*\(beckenham-historical-association.org\)/);
  assert.match(messages.error[0], /bha.unknown.example \(no Cloudflare zone found/);
});

test('a failure is logged, never thrown', async () => {
  const errors = [];
  const { fetchImpl } = fakeCloudflare({ fail: true });
  const cdn = createCachePurger({ env, paths: ['/'], fetchImpl, log: { log: () => {}, error: (m) => errors.push(m) } });
  assert.equal(await cdn.purge(), false);
  assert.match(errors.at(-1), /Cloudflare said 403: Authentication error/);
  assert.equal(errors.filter((m) => m.includes("it'll update within 5 minutes")).length, 3, 'one message per address');
});
