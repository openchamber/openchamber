import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import { z } from 'zod';
import type { JsonValue } from '../shared/json-values.js';

const VERSION = 1;
const FILE_NAME = 'skills-installed-sources.json';

// Generous cap for the bounded reads below (#1627): legitimate provenance
// is a few small fields per install, so even thousands of recorded installs
// fit in a fraction of this; anything larger is not a file these readers
// can trust.
export const INSTALLED_SOURCES_MAX_BYTES = 8 * 1024 * 1024;

export interface InstalledSourceEntry {
  skillName: string;
  skillDir: string;
  sourceId: string;
  scope?: unknown;
  source?: unknown;
  sourceRef?: unknown;
}

const isInstalledSourceEntry = (value: unknown): value is InstalledSourceEntry =>
  value !== null && typeof value === 'object'
    && 'skillName' in value && typeof value.skillName === 'string' && Boolean(value.skillName.trim())
    && 'sourceId' in value && typeof value.sourceId === 'string' && Boolean(value.sourceId.trim())
    && 'skillDir' in value && typeof value.skillDir === 'string' && Boolean(value.skillDir.trim());


const installedSourcesPath = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  FILE_NAME,
);

const entryKey = (entry: InstalledSourceEntry) => [entry.sourceId, entry.skillDir, entry.scope].join(' ');

// The provenance file: this format's version and a list; entries are judged one by one below.
const installedSourcesFileSchema = z.object({ version: z.literal(VERSION), entries: z.array(z.unknown()) });

const entriesByName = (payload: JsonValue) => {
  const file = installedSourcesFileSchema.safeParse(payload);
  if (!file.success) return null;
  const byName = new Map<string, InstalledSourceEntry[]>();
  for (const entry of file.data.entries) {
    if (!isInstalledSourceEntry(entry)) continue;
    const skillName = entry.skillName.trim();
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
  return Object.assign(new Error(
    `${installedSourcesPath()} is malformed. Fix or move it before saving; refusing to overwrite it.`,
  ), { code: 'MALFORMED' });
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
export const appendInstalledSources = <Entries>(entries: Entries) => {
  const valid = (Array.isArray(entries) ? entries : []).filter(isInstalledSourceEntry);
  if (valid.length === 0) return;

  const existing = readInstalledSourcesForUpdate();
  const byName = new Map<string, InstalledSourceEntry[]>();
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
export const removeInstalledSources = (skillName: string) => {
  const existing = readInstalledSourcesForUpdate();
  if (!existing.has(skillName)) return;
  existing.delete(skillName);
  writeEntries([...existing.values()].flat());
};

const writeEntries = (entries: InstalledSourceEntry[]) => {
  const target = installedSourcesPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, entries }, null, 2), { mode: 0o600 });
  renameSyncWithRetry((from, to) => fs.renameSync(from, to), tmp, target);
};

export const isInstalledFromSource = <Directory>(provenanceByName: Map<string, InstalledSourceEntry[]>, skillName: string, sourceId: string, skillDir: Directory) => {
  const provenance = provenanceByName.get(skillName);
  return !provenance || provenance.length === 0
    || provenance.some((entry) => entry.sourceId === sourceId && entry.skillDir === skillDir);
};
