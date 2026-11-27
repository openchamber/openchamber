import { isDeepStrictEqual } from 'node:util';
import { profilePartOf } from './settings-files.js';
import type { createSettingsFileState } from './settings-file-state.js';
import type { SettingsDocument } from './settings-helpers.js';
import type fsModule from 'node:fs/promises';
import type pathModule from 'node:path';

const LEGACY_PROFILE_BACKUP_FILE_NAME = 'settings.legacy-profile.json';

const isDocument = (value: unknown): value is SettingsDocument => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseDocument = (text: string): SettingsDocument => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isDocument(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const backupHiddenLegacyProfile = async ({ fsPromises, path, settingsFilePath, settingsFileState, replaceFile, flushToDisk }: {
  fsPromises: Pick<typeof fsModule, 'readFile' | 'writeFile' | 'rm'>;
  path: Pick<typeof pathModule, 'join' | 'dirname'>;
  settingsFilePath: string;
  settingsFileState: Pick<ReturnType<typeof createSettingsFileState>, 'readAccepted'>;
  replaceFile: (tmp: string, target: string) => Promise<void>;
  flushToDisk: (filePath: string) => Promise<void>;
}, nextText: string) => {
  const current = settingsFileState.readAccepted('settings');
  const preferences = settingsFileState.readAccepted('preferences');
  if (!current || !preferences) return;
  const next = parseDocument(nextText);
  const hidden = Object.entries(profilePartOf(current))
    .filter(([key, value]) => !Object.hasOwn(preferences[key] ?? {}, 'value') && !isDeepStrictEqual(value, next[key]));
  if (hidden.length === 0) return;
  const backupPath = path.join(path.dirname(settingsFilePath), LEGACY_PROFILE_BACKUP_FILE_NAME);
  let kept: SettingsDocument = {};
  try {
    kept = parseDocument(await fsPromises.readFile(backupPath, 'utf8'));
  } catch (error) {
    if (!isDocument(error) || error.code !== 'ENOENT') throw error;
  }
  const missing = hidden.filter(([key]) => !Object.hasOwn(kept, key));
  if (missing.length === 0) return;
  const tmp = `${backupPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsPromises.writeFile(tmp, JSON.stringify({ ...kept, ...Object.fromEntries(missing) }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await flushToDisk(tmp);
    await replaceFile(tmp, backupPath);
  } finally {
    await fsPromises.rm(tmp, { force: true }).catch(() => {});
  }
  console.warn(`[settings] Kept profile values that preferences.json does not hold in ${LEGACY_PROFILE_BACKUP_FILE_NAME}: ${missing.map(([key]) => key).join(', ')}`);
};
