// Version history of the events file: one timestamped copy per saved version,
// kept in a backups folder. Versions from the last 7 days are kept, and the
// newest 10 are always kept however old they are.
//
// File names say when and why each version was made, e.g.
//   2026-10-22T09-15-03-123Z--saved--1a2b3c4d5e6f7a8b.txt
//   2026-10-22T09-20-00-000Z--before-restore--…txt
//   2026-10-22T09-20-00-001Z--restored--from-2026-10-21T18-00-00-000Z--…txt

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RETENTION_DAYS = 7;
export const MIN_KEEP = 10;

const KINDS = ['saved', 'restored', 'before-restore', 'earlier'];
const STAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';
const NAME = new RegExp(`^(${STAMP})--(${KINDS.join('|')})(?:--from-(${STAMP}))?--([0-9a-f]{16})$`);
// Backups made before version history existed: the file as it was before each save.
const LEGACY_NAME = new RegExp(`^events-(${STAMP})-[0-9a-f]{6}$`);

export const hashOf = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const toStamp = (date) => date.toISOString().replace(/[:.]/g, '-');
const fromStamp = (stamp) => new Date(stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));

export class UnknownVersionError extends Error {}

function parseName(file) {
  const id = file.replace(/\.txt$/, '');
  let m = id.match(NAME);
  if (m) return { id, file, savedAt: fromStamp(m[1]), kind: m[2], from: m[3] ? fromStamp(m[3]) : null, hash: m[4] };
  m = id.match(LEGACY_NAME);
  if (m) return { id, file, savedAt: fromStamp(m[1]), kind: 'earlier', from: null, hash: null };
  return null;
}

export function createHistory(dir, { now = () => new Date() } = {}) {
  let lastStamp = '';

  function entries() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(parseName).filter(Boolean)
      .sort((a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id));
  }

  function read(id) {
    const entry = entries().find((e) => e.id === id); // only names we listed ourselves, never a path
    if (!entry) throw new UnknownVersionError(`No version called ${id}`);
    return { ...entry, text: fs.readFileSync(path.join(dir, entry.file), 'utf8') };
  }

  function hashOfEntry(entry) {
    return entry.hash || hashOf(fs.readFileSync(path.join(dir, entry.file), 'utf8'));
  }

  function snapshot(text, kind, { from = null } = {}) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown version kind ${kind}`);
    fs.mkdirSync(dir, { recursive: true });
    // Two versions in the same millisecond still get distinct, correctly ordered names.
    let stamp = toStamp(now());
    while (stamp <= lastStamp) stamp = toStamp(new Date(fromStamp(stamp).getTime() + 1));
    lastStamp = stamp;
    const name = `${stamp}--${kind}${from ? `--from-${toStamp(from)}` : ''}--${hashOf(text)}`;
    const tmp = path.join(dir, `.${name}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(dir, `${name}.txt`));
    return parseName(`${name}.txt`);
  }

  // Is this text already the newest version in the history?
  function isLatest(text) {
    const [newest] = entries();
    return Boolean(newest) && hashOfEntry(newest) === hashOf(text);
  }

  function prune() {
    const cutoff = now().getTime() - RETENTION_DAYS * 864e5;
    entries().forEach((entry, i) => {
      if (i >= MIN_KEEP && entry.savedAt.getTime() < cutoff) fs.rmSync(path.join(dir, entry.file));
    });
  }

  return { dir, entries, read, snapshot, isLatest, prune, hashOfEntry };
}
