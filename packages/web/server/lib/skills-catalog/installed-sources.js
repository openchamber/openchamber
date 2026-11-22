// Provenance for skills installed through the catalog: which source and
// repo subpath each installed skill came from, so the Installed badge can
// match a catalog item by source instead of by name alone. Name-only matching
// badged every same-named entry from every curated source (#4756).
//
// Lives in the OpenChamber data dir as one small JSON file. Entries only add
// a constraint: a name the registry has never heard of keeps the old name
// match, so skills installed before this file existed, or placed on disk by
// hand, look exactly as they did before.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asNonEmptyString } from '../shared/guards.js';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';

const VERSION = 1;
const FILE_NAME = 'skills-installed-sources.json';

// Generous cap for the bounded reads below (#1627): legitimate provenance
// is a few small fields per install, so even thousands of recorded installs
// fit in a fraction of this; anything larger is not a file these readers
// can trust.
export const INSTALLED_SOURCES_MAX_BYTES = 8 * 1024 * 1024;

// Resolved per call so a test can point OPENCHAMBER_DATA_DIR somewhere fresh.
const installedSourcesPath = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  FILE_NAME,
);

const entryKey = (entry) => [entry.sourceId, entry.skillDir, entry.scope].join(' ');

const entriesByName = (payload) => {
  if (!payload || payload.version !== VERSION || !Array.isArray(payload.entries)) return null;
  const byName = new Map();
  for (const entry of payload.entries) {
    const skillName = asNonEmptyString(entry?.skillName);
    const sourceId = asNonEmptyString(entry?.sourceId);
    const skillDir = asNonEmptyString(entry?.skillDir);
    if (!skillName || !sourceId || !skillDir) continue;
    const list = byName.get(skillName) ?? [];
    list.push(entry);
    byName.set(skillName, list);
  }
  return byName;
};

/**
 * All recorded installs keyed by skill name. A missing or malformed file is
 * "no provenance", never an error: the badge falls back to name matching
 * rather than losing its state because one write was interrupted.
 */
export const readInstalledSources = () => {
  // Bounded read (#1627): missing, malformed, over-cap and non-regular
  // files are all "no provenance", exactly as an unreadable file was
  // before — but an oversized file is refused after at most cap + 1
  // bytes, and a FIFO is refused from the opened handle instead of
  // freezing this synchronous read (and the server event loop with it).
  let result;
  try {
    result = readBoundedFileSync(installedSourcesPath(), INSTALLED_SOURCES_MAX_BYTES);
  } catch {
    return new Map();
  }
  if (!result.ok) return new Map();
  let payload;
  try {
    payload = JSON.parse(result.buffer.toString('utf8'));
  } catch {
    return new Map();
  }
  return entriesByName(payload) ?? new Map();
};

const malformedFileError = () => {
  // No parse error is attached: the refusal is about the file's state, and
  // callers log this message as-is.
  const error = new Error(
    `${installedSourcesPath()} is malformed. Fix or move it before saving; refusing to overwrite it.`,
  );
  error.code = 'MALFORMED';
  return error;
};

// Strict read for write paths (#936, following the #907 Linear pattern):
// three states — missing reads as an empty map, valid reads as its entries,
// and malformed throws MALFORMED instead of reading as empty. The lenient
// reader above conflates missing with malformed, so a writer seeding its
// merge from it would overwrite a corrupt file with an empty-seeded
// replacement and permanently destroy every recorded install's provenance.
// Any other read failure (permissions, I/O) also propagates: a writer that
// cannot see the current contents must not replace them. The malformed file
// is preserved in place, byte-identical, for the user to fix or move.
const readInstalledSourcesForUpdate = () => {
  // Bounded read (#1627) with the strict semantics the plain read had:
  // missing is an empty map, an over-cap or non-regular file is
  // MALFORMED (refused, and the file is left in place, never
  // overwritten), and any other I/O failure from the reader propagates
  // so a writer never seeds its merge from contents it could not see.
  const result = readBoundedFileSync(installedSourcesPath(), INSTALLED_SOURCES_MAX_BYTES);
  if (!result.ok) {
    if (result.reason === 'missing') return new Map();
    throw malformedFileError();
  }
  const raw = result.buffer.toString('utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw malformedFileError();
  }
  const byName = entriesByName(payload);
  if (byName === null) throw malformedFileError();
  return byName;
};

/**
 * Records provenance for freshly installed skills. Dedupes on source, repo
 * subpath and scope so a reinstall refreshes nothing and a second source for
 * the same name adds its own entry. Refuses (throws MALFORMED) rather than
 * overwrite a malformed provenance file.
 */
export const appendInstalledSources = (entries) => {
  const valid = (Array.isArray(entries) ? entries : []).filter((entry) =>
    asNonEmptyString(entry?.skillName)
    && asNonEmptyString(entry?.sourceId)
    && asNonEmptyString(entry?.skillDir));
  if (valid.length === 0) return;

  const existing = readInstalledSourcesForUpdate();
  const byName = new Map();
  for (const [name, list] of existing) byName.set(name, [...list]);

  for (const entry of valid) {
    const list = byName.get(entry.skillName) ?? [];
    if (!list.some((held) => entryKey(held) === entryKey(entry))) list.push(entry);
    byName.set(entry.skillName, list);
  }

  writeEntries([...byName.values()].flat());
};

/**
 * Forgets every recorded install of a deleted skill, so a later install from
 * another source is not narrowed by a stale entry. Without entries the name
 * falls back to the plain name match. Refuses (throws MALFORMED) rather than
 * silently no-op or overwrite when the provenance file is malformed.
 */
export const removeInstalledSources = (skillName) => {
  const existing = readInstalledSourcesForUpdate();
  if (!existing.has(skillName)) return;
  existing.delete(skillName);
  writeEntries([...existing.values()].flat());
};

// Atomic: a reader sees the previous file or the new one. The temporary name
// is unique per write, so two installs finishing together never rename each
// other's file away.
const writeEntries = (entries) => {
  const target = installedSourcesPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, entries }, null, 2), { mode: 0o600 });
  renameSyncWithRetry((from, to) => fs.renameSync(from, to), tmp, target);
};

/**
 * Whether a catalog item reads as installed: a skill with that name is on
 * disk, and, when installs of that name were recorded, one of them came from
 * this source and repo subpath.
 */
export const isInstalledFromSource = (provenanceByName, skillName, sourceId, skillDir) => {
  const provenance = provenanceByName.get(skillName);
  return !provenance || provenance.length === 0
    || provenance.some((entry) => entry.sourceId === sourceId && entry.skillDir === skillDir);
};
