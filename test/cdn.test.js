import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCachePurger } from '../lib/cdn.js';

const ZONES = { 'beckenham-historical-association.org': 'zone-bha', 'skynolimit.dev': 'zone-sky' };
const quiet = { log: () => {}, error: () => {} };

// A pretend Cloudflare API that records what it was asked.
function fakeCloudflare({ fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body), auth: options.headers.authorization });
    if (fail) return new Response('{"success":false,"errors":[{"message":"Authentication error"}]}', { status: 403 });
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

test("clears every page on every address, in each address's zone", async () => {
  const { calls, fetchImpl } = fakeCloudflare();
  const cdn = createCachePurger({ env, paths: ['/', '/events'], fetchImpl, log: quiet });
  assert.equal(await cdn.purge(), true);
  const purges = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(purges.map((c) => [c.url.match(/zones\/([^/]+)/)[1], c.body.files]), [
    ['zone-bha', ['https://beckenham-historical-association.org/', 'https://beckenham-historical-association.org/events']],
    ['zone-bha', ['https://www.beckenham-historical-association.org/', 'https://www.beckenham-historical-association.org/events']],
    ['zone-sky', ['https://bha.skynolimit.dev/', 'https://bha.skynolimit.dev/events']],
  ]);
  assert.ok(calls.every((c) => c.auth === 'Bearer test-token'));

  // Zones are only looked up the first time.
  const lookups = calls.length - purges.length;
  await cdn.purge();
  assert.equal(calls.length - lookups, purges.length * 2);
});

test('at most 30 addresses per request', async () => {
  const { calls, fetchImpl } = fakeCloudflare();
  const paths = Array.from({ length: 40 }, (_, i) => `/p${i}`);
  await createCachePurger({ env: { ...env, BHA_PUBLIC_HOSTS: 'beckenham-historical-association.org' }, paths, fetchImpl, log: quiet }).purge();
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body.files.length), [30, 10]);
});

test("an address whose zone the token can't see doesn't stop the others being cleared", async () => {
  const { calls, fetchImpl } = fakeCloudflare();
  const messages = { log: [], error: [] };
  const cdn = createCachePurger({ env: { ...env, BHA_PUBLIC_HOSTS: 'beckenham-historical-association.org,bha.unknown.example' }, paths: ['/'], fetchImpl,
    log: { log: (m) => messages.log.push(m), error: (m) => messages.error.push(m) } });
  assert.equal(await cdn.purge(), false);
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body.files), [['https://beckenham-historical-association.org/']]);
  assert.match(messages.log[0], /Cleared .*\(beckenham-historical-association.org\)/);
  assert.match(messages.error[0], /bha.unknown.example \(no Cloudflare zone found/);
});

test('a failure is logged, never thrown', async () => {
  const errors = [];
  const { fetchImpl } = fakeCloudflare({ fail: true });
  const cdn = createCachePurger({ env, paths: ['/'], fetchImpl, log: { log: () => {}, error: (m) => errors.push(m) } });
  assert.equal(await cdn.purge(), false);
  assert.match(errors[0], /Cloudflare said 403: Authentication error/);
  assert.equal(errors.length, 3, 'one message per address');
});
