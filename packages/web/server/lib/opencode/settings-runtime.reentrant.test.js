import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSettingsRuntime } from './settings-runtime.js';

it('allows managed-config refresh to read settings after an agent settings write', async () => {
  // Given the real callback shape: refreshing managed config re-reads migrated settings.
  const root = await fs.mkdtemp('/tmp/opencode/settings-refresh-');
  let runtime;
  let refreshed;
  runtime = createSettingsRuntime({
    fsPromises: fs, path, crypto, SETTINGS_FILE_PATH: path.join(root, 'settings.json'),
    sanitizeProjects: (projects) => projects ?? [], sanitizeSettingsUpdate: (value) => value,
    mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: (values) => values ?? [], formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
    onManagedPluginSettingsChanged: async () => { refreshed = await runtime.readSettingsFromDiskMigrated(); },
  });
  try {
    // When a mirrored agent-tool setting changes in ordinary agent-server mode.
    await runtime.persistSettings({ agentNotifyToolEnabled: true });
    // Then persistence and the callback both complete, without a recursive lock wait.
    expect(refreshed.agentNotifyToolEnabled).toBe(true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
