import { describe, expect, it } from 'vitest';

import { createSettingsHelpers } from './settings-helpers.js';
import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';

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

const createTestHelpersWithRealSanitizers = () => {
  const runtime = createSettingsNormalizationRuntime({
    os: { homedir: () => '/home/testuser' },
    path: {
      resolve: (...args) => args[args.length - 1],
      sep: '/',
      dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    },
    processLike: { platform: 'linux', env: {} },
    realpathSync: (p) => p,
    tunnelBootstrapTtlDefaultMs: 600000,
    tunnelBootstrapTtlMinMs: 60000,
    tunnelBootstrapTtlMaxMs: 3600000,
    tunnelSessionTtlDefaultMs: 86400000,
    tunnelSessionTtlMinMs: 3600000,
    tunnelSessionTtlMaxMs: 604800000,
  });
  return createSettingsHelpers({
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
    normalizeStringArray: runtime.normalizeStringArray,
    sanitizeModelRefs: runtime.sanitizeModelRefs,
    sanitizeSkillCatalogs: () => undefined,
    sanitizeProjects: () => undefined,
  });
};

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

  it('sanitizes the persisted terminal shell', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ terminalShell: ' ZSH ' })).toEqual({ terminalShell: 'zsh' });
    expect(helpers.sanitizeSettingsUpdate({ terminalShell: 'auto' })).toEqual({ terminalShell: 'auto' });
    expect(helpers.sanitizeSettingsUpdate({ terminalShell: '/bin/zsh' })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ terminalShell: 'zsh -c whoami' })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ terminalLoginShells: [' ZSH ', 'bash', 'zsh', '/bin/fish', 42] })).toEqual({
      terminalLoginShells: ['zsh', 'bash'],
    });
    expect(helpers.sanitizeSettingsUpdate({ terminalLoginShells: [] })).toEqual({ terminalLoginShells: [] });
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

  it('accepts desktopKeepAwakeEnabled as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ desktopKeepAwakeEnabled: true })).toEqual({
      desktopKeepAwakeEnabled: true,
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopKeepAwakeEnabled: false })).toEqual({
      desktopKeepAwakeEnabled: false,
    });
  });

  it('accepts desktopMinimizeToTrayEnabled as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ desktopMinimizeToTrayEnabled: true })).toEqual({
      desktopMinimizeToTrayEnabled: true,
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopMinimizeToTrayEnabled: false })).toEqual({
      desktopMinimizeToTrayEnabled: false,
    });
  });

  it('accepts desktopMacMenuBarEnabled as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ desktopMacMenuBarEnabled: true })).toEqual({
      desktopMacMenuBarEnabled: true,
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopMacMenuBarEnabled: false })).toEqual({
      desktopMacMenuBarEnabled: false,
    });
    expect(helpers.formatSettingsResponse({ desktopMacMenuBarEnabled: false })).toMatchObject({
      desktopMacMenuBarEnabled: false,
    });
  });

  it('sanitizes the persisted permission auto-accept policy', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({
      permissionAutoAccept: {
        sessions: { root: true, child: false, invalid: 'true' },
      },
    })).toEqual({
      permissionAutoAccept: {
        sessions: { root: true, child: false },
        revision: 0,
      },
    });
  });

  it('accepts desktopUiPassword as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ desktopUiPassword: ' secret ' })).toEqual({
      desktopUiPassword: 'secret',
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopUiPassword: '' })).toEqual({
      desktopUiPassword: '',
    });
  });

  it('accepts mobileKeyboardMode as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ mobileKeyboardMode: 'native' })).toEqual({
      mobileKeyboardMode: 'native',
    });
    expect(helpers.sanitizeSettingsUpdate({ mobileKeyboardMode: 'resize-content' })).toEqual({
      mobileKeyboardMode: 'resize-content',
    });
    expect(helpers.sanitizeSettingsUpdate({ mobileKeyboardMode: ' resize-content ' })).toEqual({
      mobileKeyboardMode: 'resize-content',
    });
  });

  it('rejects invalid mobileKeyboardMode values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ mobileKeyboardMode: 'fixed-layout' })).toEqual({});
  });

  it('accepts collapsibleThinkingBlocks as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ collapsibleThinkingBlocks: true })).toEqual({
      collapsibleThinkingBlocks: true,
    });
    expect(helpers.sanitizeSettingsUpdate({ collapsibleThinkingBlocks: false })).toEqual({
      collapsibleThinkingBlocks: false,
    });
  });

  it('accepts discord config and clears it with null', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({
      discord: {
        botToken: ' tok ',
        guildId: '123',
        listenerEnabled: false,
        autoReply: true,
        projectBindings: [{ channelId: 'c1', projectPath: '/p', projectLabel: 'P' }],
      },
    })).toEqual({
      discord: {
        botToken: 'tok',
        guildId: '123',
        listenerEnabled: false,
        autoReply: true,
        projectBindings: [{ channelId: 'c1', projectPath: '/p', projectLabel: 'P' }],
      },
    });

    expect(helpers.sanitizeSettingsUpdate({ discord: null })).toEqual({ discord: null });

    const merged = helpers.mergePersistedSettings(
      { themeId: 'default', discord: { botToken: 'tok' } },
      { discord: null },
    );
    expect(merged.discord).toBeUndefined();
    expect(merged.themeId).toBe('default');
  });

  it('normalizes discord defaultReplyMode and guildPolicies, dropping invalid entries', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({
      discord: {
        botToken: 'tok',
        defaultReplyMode: 'mention',
        guildPolicies: {
          '111': { enabled: true, replyMode: 'always' },
          '222': { enabled: false },
          '333': { replyMode: 'inherit' },
          '': { enabled: true },
          '444': { replyMode: 'bogus', enabled: 'yes' },
          '555': {},
        },
      },
    })).toEqual({
      discord: {
        botToken: 'tok',
        defaultReplyMode: 'mention',
        guildPolicies: {
          '111': { enabled: true, replyMode: 'always' },
          '222': { enabled: false },
          '333': { replyMode: 'inherit' },
        },
      },
    });

    expect(helpers.sanitizeSettingsUpdate({
      discord: {
        botToken: 'tok',
        defaultReplyMode: 'bogus',
        guildPolicies: null,
      },
    })).toEqual({
      discord: {
        botToken: 'tok',
      },
    });
  });

  it('accepts shortcut overrides as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({
      shortcutOverrides: {
        open_settings: 'mod+comma',
        new_chat: '__unassigned__',
        invalid: 123,
        empty: '',
      },
    })).toEqual({
      shortcutOverrides: {
        open_settings: 'mod+comma',
        new_chat: '__unassigned__',
      },
    });
  });

  it('preserves empty shortcut overrides when resetting all shortcuts', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ shortcutOverrides: {} })).toEqual({
      shortcutOverrides: {},
    });
  });

  it('accepts OpenCode update notification preference as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ showOpenCodeUpdateNotifications: false })).toEqual({
      showOpenCodeUpdateNotifications: false,
    });
    expect(helpers.sanitizeSettingsUpdate({ showOpenCodeUpdateNotifications: true })).toEqual({
      showOpenCodeUpdateNotifications: true,
    });
  });

  it('accepts dismissed OpenCode update toast version as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ openCodeUpdateToastDismissedVersion: ' 1.16.0 ' })).toEqual({
      openCodeUpdateToastDismissedVersion: '1.16.0',
    });
    expect(helpers.sanitizeSettingsUpdate({ openCodeUpdateToastDismissedVersion: '' })).toEqual({
      openCodeUpdateToastDismissedVersion: '',
    });
  });

  it('rejects non-boolean collapsibleThinkingBlocks values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ collapsibleThinkingBlocks: 'true' })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ collapsibleThinkingBlocks: 1 })).toEqual({});
  });

  it('includes collapsibleThinkingBlocks in formatSettingsResponse', () => {
    const helpers = createTestHelpers();

    const response = helpers.formatSettingsResponse({ collapsibleThinkingBlocks: false });
    expect(response.collapsibleThinkingBlocks).toBe(false);

    const responseTrue = helpers.formatSettingsResponse({ collapsibleThinkingBlocks: true });
    expect(responseTrue.collapsibleThinkingBlocks).toBe(true);
  });

  it('defaults collapsibleThinkingBlocks to true in formatSettingsResponse when absent', () => {
    const helpers = createTestHelpers();

    const response = helpers.formatSettingsResponse({});
    expect(response.collapsibleThinkingBlocks).toBe(true);
  });

  it('includes transient desktop LAN access runtime status in desktop settings response', () => {
    const helpers = createTestHelpers();
    const previousRuntime = process.env.OPENCHAMBER_RUNTIME;
    const previousActive = process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE;
    const previousReason = process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON;
    try {
      process.env.OPENCHAMBER_RUNTIME = 'desktop';
      process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE = 'false';
      process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON = 'missing-password';

      const response = helpers.formatSettingsResponse({ desktopLanAccessEnabled: true });
      expect(response.desktopLanAccessActive).toBe(false);
      expect(response.desktopLanAccessBlockedReason).toBe('missing-password');
    } finally {
      if (typeof previousRuntime === 'string') process.env.OPENCHAMBER_RUNTIME = previousRuntime;
      else delete process.env.OPENCHAMBER_RUNTIME;
      if (typeof previousActive === 'string') process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE = previousActive;
      else delete process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE;
      if (typeof previousReason === 'string') process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON = previousReason;
      else delete process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON;
    }
  });

  describe('previously-dropped model selector persistence fields', () => {
    it('round-trips hiddenModels through the sanitizer', () => {
      const helpers = createTestHelpersWithRealSanitizers();
      const input = [
        { providerID: 'anthropic', modelID: 'claude-opus-4' },
        { providerID: 'openai', modelID: 'gpt-5' },
      ];

      expect(helpers.sanitizeSettingsUpdate({ hiddenModels: input })).toEqual({
        hiddenModels: input,
      });
    });

    it('handles empty hiddenModels the same way as empty favoriteModels', () => {
      const helpers = createTestHelpersWithRealSanitizers();

      const hiddenResult = helpers.sanitizeSettingsUpdate({ hiddenModels: [] });
      const favoriteResult = helpers.sanitizeSettingsUpdate({ favoriteModels: [] });

      expect(hiddenResult.hiddenModels).toEqual([]);
      expect(favoriteResult.favoriteModels).toEqual([]);
      expect(hiddenResult.hiddenModels).toEqual(favoriteResult.favoriteModels);
    });

    it('round-trips collapsedModelProviders and recentAgents as string arrays', () => {
      const helpers = createTestHelpersWithRealSanitizers();

      expect(helpers.sanitizeSettingsUpdate({ collapsedModelProviders: ['anthropic', 'openai'] })).toEqual({
        collapsedModelProviders: ['anthropic', 'openai'],
      });
      expect(helpers.sanitizeSettingsUpdate({ recentAgents: ['build', 'plan'] })).toEqual({
        recentAgents: ['build', 'plan'],
      });
    });

    it('round-trips recentEfforts as a Record<string, string[]>', () => {
      const helpers = createTestHelpersWithRealSanitizers();
      const input = {
        'anthropic/claude-opus-4': ['high', 'default'],
        'openai/gpt-5': ['low'],
      };

      expect(helpers.sanitizeSettingsUpdate({ recentEfforts: input })).toEqual({
        recentEfforts: input,
      });
    });

    it('rejects garbage hiddenModels input the same way sanitizeModelRefs rejects bad refs', () => {
      const helpers = createTestHelpersWithRealSanitizers();

      expect(helpers.sanitizeSettingsUpdate({ hiddenModels: 'not-an-array' })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ hiddenModels: null })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ hiddenModels: 123 })).toEqual({});
      expect(
        helpers.sanitizeSettingsUpdate({
          hiddenModels: [
            { providerID: 'anthropic' },
            { modelID: 'gpt-5' },
            'not-an-object',
            null,
            { providerID: '  ', modelID: 'x' },
            { providerID: 'openai', modelID: '' },
          ],
        })
      ).toEqual({ hiddenModels: [] });
    });

    it('rejects garbage collapsedModelProviders and recentAgents input', () => {
      const helpers = createTestHelpersWithRealSanitizers();

      expect(helpers.sanitizeSettingsUpdate({ collapsedModelProviders: 'anthropic' })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ collapsedModelProviders: null })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ recentAgents: 42 })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ recentAgents: { build: 1 } })).toEqual({});
    });

    it('rejects garbage recentEfforts input', () => {
      const helpers = createTestHelpersWithRealSanitizers();

      expect(helpers.sanitizeSettingsUpdate({ recentEfforts: 'not-an-object' })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ recentEfforts: [] })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ recentEfforts: null })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ recentEfforts: { 'anthropic/claude-opus-4': 'high' } })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ recentEfforts: { '': ['high'] } })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ recentEfforts: { 'anthropic/claude-opus-4': [] } })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ recentEfforts: { 'anthropic/claude-opus-4': [123, ''] } })).toEqual({});
    });

    it('survives a full settings.json payload containing all four previously-dropped fields (regression)', () => {
      const helpers = createTestHelpersWithRealSanitizers();
      const payload = {
        themeId: 'default',
        hiddenModels: [
          { providerID: 'anthropic', modelID: 'claude-opus-4' },
          { providerID: 'openai', modelID: 'gpt-5' },
        ],
        collapsedModelProviders: ['anthropic', 'openai'],
        recentAgents: ['build', 'plan'],
        recentEfforts: {
          'anthropic/claude-opus-4': ['high', 'default'],
          'openai/gpt-5': ['low'],
        },
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
        recentModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
      };

      const sanitized = helpers.sanitizeSettingsUpdate(payload);

      expect(sanitized.hiddenModels).toEqual(payload.hiddenModels);
      expect(sanitized.collapsedModelProviders).toEqual(payload.collapsedModelProviders);
      expect(sanitized.recentAgents).toEqual(payload.recentAgents);
      expect(sanitized.recentEfforts).toEqual(payload.recentEfforts);
      expect(sanitized.favoriteModels).toEqual(payload.favoriteModels);
      expect(sanitized.recentModels).toEqual(payload.recentModels);
    });
  });
});
