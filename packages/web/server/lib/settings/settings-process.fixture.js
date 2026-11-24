import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createSettingsRuntime } from './settings-runtime.js';

const [root = '', name = ''] = process.argv.slice(2);
const runtime = createSettingsRuntime({
  fsPromises, path, crypto,
  SETTINGS_FILE_PATH: path.join(root, 'settings.json'),
  sanitizeProjects: () => [],
  sanitizeSettingsUpdate: (settings) => settings,
  mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
  normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
  normalizeStringArray: () => [],
  formatSettingsResponse: (settings) => settings,
  resolveDirectoryCandidate: (value) => value,
  normalizeManagedRemoteTunnelHostname: (value) => value,
  normalizeManagedRemoteTunnelPresets: (value) => value,
  normalizeManagedRemoteTunnelPresetTokens: (value) => value,
  syncManagedRemoteTunnelConfigWithPresets: async () => {},
  upsertManagedRemoteTunnelToken: async () => {},
});
const profileKey = name === 'one' ? 'lightThemeId' : 'darkThemeId';
for (let index = 0; index < 20; index += 1) {
  await runtime.persistSettings({ [`${name}-${index}`]: true, [profileKey]: `${name}-${index}` });
}
