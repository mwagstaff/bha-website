// Clears the public pages from Cloudflare's cache after an editor save, so
// edits show straight away instead of within PUBLIC_CACHE (5 minutes).
//
// Everything cached for each of the site's own hostnames is cleared, since
// clearing single addresses can miss pages Cloudflare's cache rules file under
// a different key. If Cloudflare won't clear a hostname, the pages' addresses
// are cleared one by one instead.
//
// Needs CLOUDFLARE_PURGE_TOKEN (an API token with Zone > Cache Purge and
// Zone > Zone > Read for the site's zones) and BHA_PUBLIC_HOSTS, the
// addresses the site is reached at, e.g.
//   beckenham-historical-association.org,bha.skynolimit.dev
// Without both, nothing is cleared. A failure is only logged: the save has
// already happened, and the pages update within 5 minutes anyway.

const API = 'https://api.cloudflare.com/client/v4';
const MAX_FILES = 30; // per purge request

export function createCachePurger({ env = process.env, paths, fetchImpl = fetch, log = console } = {}) {
  const token = String(env.CLOUDFLARE_PURGE_TOKEN ?? '').trim();
  const hosts = String(env.BHA_PUBLIC_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!token || !hosts.length) return { enabled: false, purge: async () => false };

  const call = async (url, options = {}) => {
    const res = await fetchImpl(`${API}${url}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) throw new Error(`Cloudflare said ${res.status}${body?.errors?.[0] ? `: ${body.errors[0].message}` : ''}`);
    return body.result;
  };

  // Each host's zone is found once: the zone named after the host or the domain it's under.
  const zones = new Map();
  async function zoneFor(host) {
    if (!zones.has(host)) {
      const parts = host.split('.');
      let id = null;
      for (let i = 0; i < parts.length - 1 && !id; i++) {
        const [zone] = await call(`/zones?name=${encodeURIComponent(parts.slice(i).join('.'))}`);
        id = zone?.id || null;
      }
      if (!id) throw new Error(`no Cloudflare zone found for ${host}`);
      zones.set(host, id);
    }
    return zones.get(host);
  }

  // Each address is cleared on its own, so a problem with one doesn't hold up the others.
  async function purgeHost(host) {
    const id = await zoneFor(host);
    const purgeWith = (body) => call(`/zones/${id}/purge_cache`, { method: 'POST', body: JSON.stringify(body) });
    try {
      await purgeWith({ hosts: [host] });
      return;
    } catch (err) {
      log.error(`[cdn] Couldn't clear all of ${host} (${err.message}); clearing its pages one by one.`);
    }
    const files = paths.map((p) => `https://${host}${p}`);
    for (let i = 0; i < files.length; i += MAX_FILES) await purgeWith({ files: files.slice(i, i + MAX_FILES) });
  }

  async function purge() {
    const results = await Promise.allSettled(hosts.map(purgeHost));
    const cleared = hosts.filter((h, i) => results[i].status === 'fulfilled');
    if (cleared.length) log.log(`[cdn] Cleared the public pages from Cloudflare (${cleared.join(', ')})`);
    results.forEach((r, i) => {
      if (r.status === 'rejected') log.error(`[cdn] Couldn't clear Cloudflare's copy of ${hosts[i]} (${r.reason.message}); it'll update within 5 minutes.`);
    });
    return cleared.length === hosts.length;
  }

  return { enabled: true, purge };
}
