// Prints the site's current events and page text as JSON ({ events, pages },
// each in its file format), from wherever the site keeps them (files or Mongo,
// as set by BHA_STORAGE). Run on the server by pull-content.zsh, with the
// site's environment.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStorage } from '../lib/storage.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.BHA_DATA_DIR || path.join(root, 'var');
const storage = await openStorage({
  mode: process.env.BHA_STORAGE,
  uri: process.env.MONGODB_URI_BHA,
  dataDir,
  backupDir: process.env.BHA_BACKUP_DIR || path.join(dataDir, 'backups'),
  seedEventsFile: path.join(root, 'content', 'events.txt'),
});
try {
  if (storage.health().database === 'unreachable') throw new Error("Mongo couldn't be reached");
  const [events, pages] = await Promise.all([storage.docs.events.read(), storage.docs.pages.read()]);
  process.stdout.write(JSON.stringify({ storage: storage.mode, events, pages }));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await storage.close();
}
