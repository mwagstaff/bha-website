import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnquiry, isSpam, enquiryEmail, sendEnquiry } from '../lib/enquiry.js';

const ENV = { PLUNK_SECRET_KEY: 'sk_test_only', BHA_ENQUIRY_TO: 'secretary@example.com', BHA_EMAIL_FROM: 'bha@example.org' };
const enquiry = readEnquiry({ formtype: 'Bulletin Request', name: ' Ada <Lovelace> ', address: '1 High St\nBeckenham', pcode: 'BR3 1AA', email: 'ada@example.com' });

test('readEnquiry requires name, address and postcode and trims the rest', () => {
  assert.equal(readEnquiry({ name: 'A', address: 'B' }), null);
  assert.equal(enquiry.name, 'Ada <Lovelace>');
  assert.equal(readEnquiry({ formtype: 'Anything', name: 'A', address: 'B', pcode: 'C' }).formtype, 'Membership Enquiry');
});

test('the honeypot field marks bots', () => {
  assert.equal(isSpam({ website: '' }), false);
  assert.equal(isSpam({ website: 'http://spam.example' }), true);
});

test('the email escapes what people typed and keeps line breaks', () => {
  const { subject, body } = enquiryEmail(enquiry);
  assert.equal(subject, 'Bulletin Request from Ada <Lovelace>');
  assert.match(body, /Ada &lt;Lovelace&gt;/);
  assert.match(body, /1 High St<br>Beckenham/);
  assert.doesNotMatch(body, /Contact number/);
});

test('without full configuration nothing is sent', async () => {
  const fetchImpl = () => assert.fail('should not send');
  assert.equal(await sendEnquiry(enquiry, { env: { ...ENV, BHA_ENQUIRY_TO: '' }, fetchImpl }), false);
});

test('sends through Plunk with the enquirer as reply-to', async () => {
  let request;
  const fetchImpl = async (url, options) => { request = { url, options }; return new Response('{"success":true}'); };
  assert.equal(await sendEnquiry(enquiry, { env: ENV, fetchImpl }), true);
  assert.equal(request.url, 'https://next-api.useplunk.com/v1/send');
  assert.equal(request.options.headers.authorization, 'Bearer sk_test_only');
  const sent = JSON.parse(request.options.body);
  assert.equal(sent.to, 'secretary@example.com');
  assert.deepEqual(sent.from, { name: 'BHA website', email: 'bha@example.org' });
  assert.equal(sent.reply, 'ada@example.com');
});

test('bulletin requests go to BHA_BULLETIN_TO, membership enquiries to BHA_ENQUIRY_TO', async () => {
  const sentTo = [];
  const fetchImpl = async (url, options) => { sentTo.push(JSON.parse(options.body).to); return new Response('{"success":true}'); };
  const env = { ...ENV, BHA_BULLETIN_TO: 'editor@example.com' };
  await sendEnquiry(enquiry, { env, fetchImpl });
  await sendEnquiry({ ...enquiry, formtype: 'Membership Enquiry' }, { env, fetchImpl });
  assert.deepEqual(sentTo, ['editor@example.com', 'secretary@example.com']);
});

test('a refused send throws', async () => {
  const fetchImpl = async () => new Response('{"success":false}', { status: 422 });
  await assert.rejects(sendEnquiry(enquiry, { env: ENV, fetchImpl }), /HTTP 422/);
});

test('a recipient chosen in the editor wins over the environment', async () => {
  let sent;
  const fetchImpl = async (url, options) => { sent = JSON.parse(options.body); return new Response('{"success":true}'); };
  await sendEnquiry(enquiry, { to: 'chosen@example.com', env: { ...ENV, BHA_BULLETIN_TO: 'editor@example.com' }, fetchImpl });
  assert.equal(sent.to, 'chosen@example.com');
});
