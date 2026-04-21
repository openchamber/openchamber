import { describe, expect, it } from 'vitest';

import { createSettingsHelpers } from './settings-helpers.js';

const createTestHelpers = () => createSettingsHelpers({
  normalizePathForPersistence: (value) => value,
  normalizeDirectoryPath: (value) => value,
  normalizeTunnelBootstrapTtlMs: (value) => value,
  normalizeTunnelSessionTtlMs: (value) => value,
  normalizeTunnelProvider: (value) => value,
  normalizeTunnelMode: (value) => value,
  normalizeOptionalPath: (value) => value,
  normalizeManagedRemoteTunnelHostname: (value) => value,
  normalizeManagedRemoteTunnelPresets: () => undefined,
  normalizeManagedRemoteTunnelPresetTokens: () => undefined,
  sanitizeTypographySizesPartial: () => undefined,
  normalizeStringArray: (input) => input,
  sanitizeModelRefs: () => undefined,
  sanitizeSkillCatalogs: () => undefined,
  sanitizeProjects: () => undefined,
});

describe('settings helpers', () => {
  it('accepts messageStreamTransport as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ messageStreamTransport: 'ws' })).toEqual({
      messageStreamTransport: 'ws',
    });
    expect(helpers.sanitizeSettingsUpdate({ messageStreamTransport: 'sse' })).toEqual({
      messageStreamTransport: 'sse',
    });
    expect(helpers.sanitizeSettingsUpdate({ messageStreamTransport: 'auto' })).toEqual({
      messageStreamTransport: 'auto',
    });
  });

  it('rejects invalid messageStreamTransport values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ messageStreamTransport: 'websocket' })).toEqual({});
  });

  it('accepts desktopLanAccessEnabled as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ desktopLanAccessEnabled: true })).toEqual({
      desktopLanAccessEnabled: true,
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopLanAccessEnabled: false })).toEqual({
      desktopLanAccessEnabled: false,
    });
  });
});
