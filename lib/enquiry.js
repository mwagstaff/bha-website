// Membership and bulletin enquiries, emailed through Plunk (replaces the old
// formSubmit.php). Without PLUNK_SECRET_KEY, BHA_ENQUIRY_TO and BHA_EMAIL_FROM
// (e.g. on the preview) enquiries are only logged.

const PLUNK_SEND_URL = 'https://next-api.useplunk.com/v1/send';
const FORM_TYPES = ['Membership Enquiry', 'Bulletin Request'];
const FIELDS = [['name', 'Name'], ['address', 'Address'], ['pcode', 'Postcode'], ['phone', 'Contact number'], ['email', 'Email address']];

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Trimmed, length-limited copies of the submitted fields, or null if a required one is missing.
export function readEnquiry(body) {
  const value = (key, max) => String(body?.[key] ?? '').trim().slice(0, max);
  const enquiry = {
    formtype: FORM_TYPES.includes(body?.formtype) ? body.formtype : FORM_TYPES[0],
    name: value('name', 200), address: value('address', 1000), pcode: value('pcode', 20),
    phone: value('phone', 50), email: value('email', 200),
  };
  return enquiry.name && enquiry.address && enquiry.pcode ? enquiry : null;
}

// Filled in only by bots: the field is hidden from people and screen readers.
export const isSpam = (body) => Boolean(String(body?.website ?? '').trim());

export function enquiryEmail(enquiry) {
  const rows = FIELDS.filter(([key]) => enquiry[key]).map(([key, label]) =>
    `<tr><th align="left" valign="top" style="padding:4px 12px 4px 0">${label}</th><td style="padding:4px 0">${escapeHtml(enquiry[key]).replace(/\n/g, '<br>')}</td></tr>`);
  return {
    subject: `${enquiry.formtype} from ${enquiry.name.replace(/\s+/g, ' ')}`,
    body: `<p>New ${escapeHtml(enquiry.formtype.toLowerCase())} from the website:</p><table>${rows.join('')}</table>`,
  };
}

const validEmail = (s) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);

// Returns false when email isn't configured; throws if Plunk refuses the message.
export async function sendEnquiry(enquiry, { env = process.env, fetchImpl = fetch } = {}) {
  const key = String(env.PLUNK_SECRET_KEY ?? '').trim();
  const to = String(env.BHA_ENQUIRY_TO ?? '').trim();
  const from = String(env.BHA_EMAIL_FROM ?? '').trim();
  if (!key || !to || !from) return false;
  const { subject, body } = enquiryEmail(enquiry);
  const message = { to, from: { name: 'BHA website', email: from }, subject, body };
  if (validEmail(enquiry.email)) message.reply = enquiry.email;
  const response = await fetchImpl(PLUNK_SEND_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) throw new Error(`Plunk rejected the enquiry email (HTTP ${response.status})`);
  return true;
}
