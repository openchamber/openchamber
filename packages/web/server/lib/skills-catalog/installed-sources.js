import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asNonEmptyString } from '../shared/guards.js';

const VERSION = 1;
const FILE_NAME = 'skills-installed-sources.json';

const installedSourcesPath = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  FILE_NAME,
);

const entryKey = (entry) => [entry.sourceId, entry.skillDir, entry.scope].join(' ');

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

export const removeInstalledSources = (skillName) => {
  const existing = readInstalledSources();
  if (!existing.has(skillName)) return;
  existing.delete(skillName);
  writeEntries([...existing.values()].flat());
};

const writeEntries = (entries) => {
  const target = installedSourcesPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, entries }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
};

export const isInstalledFromSource = (provenanceByName, skillName, sourceId, skillDir) => {
  const provenance = provenanceByName.get(skillName);
  return !provenance || provenance.length === 0
    || provenance.some((entry) => entry.sourceId === sourceId && entry.skillDir === skillDir);
};
