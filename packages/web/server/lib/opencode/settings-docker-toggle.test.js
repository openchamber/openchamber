import { describe, expect, it } from 'vitest';

import { createSettingsHelpers } from './settings-helpers.js';

const createHelpers = () => createSettingsHelpers({
  normalizePathForPersistence: (value) => value,
  normalizeDirectoryPath: (value) => value,
  normalizeTunnelBootstrapTtlMs: (value) => value,
  normalizeTunnelSessionTtlMs: (value) => value,
  normalizeTunnelProvider: (value) => value,
  normalizeTunnelMode: (value) => value,
  normalizeOptionalPath: (value) => value,
  normalizeManagedRemoteTunnelHostname: (value) => value,
  normalizeManagedRemoteTunnelPresets: (value) => value,
  normalizeManagedRemoteTunnelPresetTokens: (value) => value,
  sanitizeTypographySizesPartial: (value) => value ?? {},
  normalizeStringArray: (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []),
  sanitizeModelRefs: (value) => value,
  sanitizeSkillCatalogs: (value) => value,
  sanitizeProjects: (value) => value,
});

describe('docker instances feature toggle persistence', () => {
  it('survives the settings sanitize/merge round-trip when boolean', () => {
    const helpers = createHelpers();
    const sanitized = helpers.sanitizeSettingsUpdate({ dockerInstancesEnabled: true });
    expect(sanitized.dockerInstancesEnabled).toBe(true);

    const merged = helpers.mergePersistedSettings({ existing: 'kept' }, sanitized);
    expect(merged.dockerInstancesEnabled).toBe(true);
    expect(merged.existing).toBe('kept');
  });

  it('drops non-boolean values and stays absent by default', () => {
    const helpers = createHelpers();
    const sanitized = helpers.sanitizeSettingsUpdate({ dockerInstancesEnabled: 'yes' });
    expect(sanitized.dockerInstancesEnabled).toBeUndefined();
    expect(helpers.sanitizeSettingsUpdate({}).dockerInstancesEnabled).toBeUndefined();
  });
});
