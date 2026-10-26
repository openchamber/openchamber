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

const VERSION = 1;
const FILE_NAME = 'skills-installed-sources.json';

// Resolved per call so a test can point OPENCHAMBER_DATA_DIR somewhere fresh.
const installedSourcesPath = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  FILE_NAME,
);

const entryKey = (entry) => [entry.sourceId, entry.skillDir, entry.scope].join(' ');

/**
 * All recorded installs keyed by skill name. A missing or malformed file is
 * "no provenance", never an error: the badge falls back to name matching
 * rather than losing its state because one write was interrupted.
 */
export const readInstalledSources = () => {
  const byName = new Map();
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(installedSourcesPath(), 'utf8'));
  } catch {
    return byName;
  }
  if (!payload || payload.version !== VERSION || !Array.isArray(payload.entries)) return byName;
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
 * Records provenance for freshly installed skills. Dedupes on source, repo
 * subpath and scope so a reinstall refreshes nothing and a second source for
 * the same name adds its own entry.
 */
export const appendInstalledSources = (entries) => {
  const valid = (Array.isArray(entries) ? entries : []).filter((entry) =>
    asNonEmptyString(entry?.skillName)
    && asNonEmptyString(entry?.sourceId)
    && asNonEmptyString(entry?.skillDir));
  if (valid.length === 0) return;

  const existing = readInstalledSources();
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
 * falls back to the plain name match.
 */
export const removeInstalledSources = (skillName) => {
  const existing = readInstalledSources();
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
  fs.renameSync(tmp, target);
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
