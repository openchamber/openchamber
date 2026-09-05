import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INPUT_HISTORY_LIMIT,
} from './input-history-scope.js';
import { createSettingsHelpers } from './settings-helpers.js';
import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';

const testFilePath = fileURLToPath(import.meta.url);
const packagesWebDir = join(dirname(testFilePath), '..', '..', '..');

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
  it('imports from the packed @openchamber/web tarball without escaping the published package', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'settings-helpers-pack-'));
    const packDir = join(tempRoot, 'pack');
    const extractDir = join(tempRoot, 'extract');

    try {
      mkdirSync(packDir);
      mkdirSync(extractDir);
      execFileSync('npm', ['pack', '--silent', '--pack-destination', packDir], {
        cwd: packagesWebDir,
        stdio: 'pipe',
      });

      const tarballName = readdirSync(packDir).find((entry) => entry.endsWith('.tgz'));
      expect(tarballName).toBeTruthy();

      execFileSync('tar', ['-xzf', join(packDir, tarballName), '-C', extractDir], {
        stdio: 'pipe',
      });

      const extractedModule = await import(
        pathToFileURL(join(extractDir, 'package', 'server', 'lib', 'opencode', 'settings-helpers.js')).href
      );

      const helpers = extractedModule.createSettingsHelpers({
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

      expect(helpers.sanitizeSettingsUpdate({ inputHistoryScope: 'global' })).toEqual({
        inputHistoryScope: 'global',
      });
      expect(helpers.sanitizeSettingsUpdate({ inputHistoryScope: 'session' })).toEqual({
        inputHistoryScope: 'session',
      });
      expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: 40 })).toEqual({
        inputHistoryLimit: 40,
      });
      expect(helpers.formatSettingsResponse({})).toMatchObject({
        inputHistoryScope: 'session',
        inputHistoryLimit: DEFAULT_INPUT_HISTORY_LIMIT,
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts only booleans for draft starter visibility', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ draftStartersVisible: true })).toEqual({ draftStartersVisible: true });
    expect(helpers.sanitizeSettingsUpdate({ draftStartersVisible: false })).toEqual({ draftStartersVisible: false });
    expect(helpers.sanitizeSettingsUpdate({ draftStartersVisible: 'false' })).toEqual({});
  });

  it('sanitizes both Enter settings independently', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ enterToSend: true })).toEqual({ enterToSend: true });
    expect(helpers.sanitizeSettingsUpdate({ enterToSendConfigured: false })).toEqual({ enterToSendConfigured: false });
    expect(helpers.sanitizeSettingsUpdate({ enterToSend: 'true', enterToSendConfigured: 1 })).toEqual({});
  });

  it('sanitizes shared sidebar display preferences', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({
      sidebarProjectDisplayMode: 'single',
      sidebarSessionGroupingMode: 'flat',
      sidebarProjectSortOrder: 'z-a',
      sidebarShowRecentSection: false,
    })).toEqual({
      sidebarProjectDisplayMode: 'single',
      sidebarSessionGroupingMode: 'flat',
      sidebarProjectSortOrder: 'z-a',
      sidebarShowRecentSection: false,
    });
    expect(helpers.sanitizeSettingsUpdate({
      sidebarProjectDisplayMode: 'grid',
      sidebarSessionGroupingMode: 'project',
      sidebarProjectSortOrder: 'random',
      sidebarShowRecentSection: 'false',
    })).toEqual({});
  });

  it('persists valid tool JSON view modes', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ toolJsonViewMode: 'summary' })).toEqual({ toolJsonViewMode: 'summary' });
    expect(helpers.sanitizeSettingsUpdate({ toolJsonViewMode: 'formatted' })).toEqual({ toolJsonViewMode: 'formatted' });
    expect(helpers.sanitizeSettingsUpdate({ toolJsonViewMode: 'raw' })).toEqual({ toolJsonViewMode: 'raw' });
    expect(helpers.sanitizeSettingsUpdate({ toolJsonViewMode: 'unknown' })).toEqual({});
  });

  it('accepts only booleans for wide chat layout', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ wideChatLayoutEnabled: true })).toEqual({ wideChatLayoutEnabled: true });
    expect(helpers.sanitizeSettingsUpdate({ wideChatLayoutEnabled: false })).toEqual({ wideChatLayoutEnabled: false });
    expect(helpers.sanitizeSettingsUpdate({ wideChatLayoutEnabled: 'true' })).toEqual({});
  });

  it('accepts only booleans for collapsible user messages', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ collapsibleUserMessages: true })).toEqual({ collapsibleUserMessages: true });
    expect(helpers.sanitizeSettingsUpdate({ collapsibleUserMessages: false })).toEqual({ collapsibleUserMessages: false });
    expect(helpers.sanitizeSettingsUpdate({ collapsibleUserMessages: 'true' })).toEqual({});
  });

  it('sanitizes and returns the persisted editor font size', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ editorFontSize: 20.6 })).toEqual({ editorFontSize: 21 });
    expect(helpers.sanitizeSettingsUpdate({ editorFontSize: 8 })).toEqual({ editorFontSize: 9 });
    expect(helpers.sanitizeSettingsUpdate({ editorFontSize: 33 })).toEqual({ editorFontSize: 32 });
    expect(helpers.sanitizeSettingsUpdate({ editorFontSize: Number.NaN })).toEqual({});
    expect(helpers.formatSettingsResponse({ editorFontSize: 20 })).toMatchObject({ editorFontSize: 20 });
  });

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

  it('accepts inputHistoryScope as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ inputHistoryScope: 'global' })).toEqual({
      inputHistoryScope: 'global',
    });
    expect(helpers.sanitizeSettingsUpdate({ inputHistoryScope: 'session' })).toEqual({
      inputHistoryScope: 'session',
    });
  });

  it('accepts valid inputHistoryLimit values as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: 1 })).toEqual({
      inputHistoryLimit: 1,
    });
    expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: 40 })).toEqual({
      inputHistoryLimit: 40,
    });
    expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: 100 })).toEqual({
      inputHistoryLimit: 100,
    });
  });

  it('rejects invalid inputHistoryLimit values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: 0 })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: 101 })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: 1.5 })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: '40' })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: Number.NaN })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: Number.POSITIVE_INFINITY })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ inputHistoryLimit: Number.NEGATIVE_INFINITY })).toEqual({});
  });

  it('rejects invalid inputHistoryScope values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ inputHistoryScope: 'workspace' })).toEqual({});
  });

  it('defaults inputHistoryScope to session in formatted settings responses', () => {
    const helpers = createTestHelpers();

    expect(helpers.formatSettingsResponse({ inputHistoryScope: 'global' })).toMatchObject({
      inputHistoryScope: 'global',
    });
    expect(helpers.formatSettingsResponse({})).toMatchObject({
      inputHistoryScope: 'session',
    });
  });

  it('defaults missing inputHistoryLimit to 40 in formatted settings responses and preserves valid values', () => {
    const helpers = createTestHelpers();

    expect(helpers.formatSettingsResponse({})).toMatchObject({
      inputHistoryLimit: DEFAULT_INPUT_HISTORY_LIMIT,
    });
    expect(helpers.formatSettingsResponse({ inputHistoryLimit: 1 })).toMatchObject({
      inputHistoryLimit: 1,
    });
    expect(helpers.formatSettingsResponse({ inputHistoryLimit: 100 })).toMatchObject({
      inputHistoryLimit: 100,
    });
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

  it('normalizes desktopWindowControlsPosition and maps legacy auto to right', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ desktopWindowControlsPosition: 'left' })).toEqual({
      desktopWindowControlsPosition: 'left',
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopWindowControlsPosition: 'right' })).toEqual({
      desktopWindowControlsPosition: 'right',
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopWindowControlsPosition: 'auto' })).toEqual({
      desktopWindowControlsPosition: 'right',
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopWindowControlsPosition: 'center' })).toEqual({});
  });

  it('sanitizes desktopWindowControlsStyle and rejects unknown values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ desktopWindowControlsStyle: 'classic' })).toEqual({
      desktopWindowControlsStyle: 'classic',
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopWindowControlsStyle: 'traffic-lights' })).toEqual({
      desktopWindowControlsStyle: 'traffic-lights',
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopWindowControlsStyle: 'macos' })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ desktopWindowControlsStyle: 'auto' })).toEqual({});
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

  it('accepts and rejects invalid Enter-to-send preference values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ enterToSend: true, enterToSendConfigured: true })).toEqual({
      enterToSend: true,
      enterToSendConfigured: true,
    });
    expect(helpers.sanitizeSettingsUpdate({ enterToSend: false, enterToSendConfigured: true })).toEqual({
      enterToSend: false,
      enterToSendConfigured: true,
    });
    expect(helpers.sanitizeSettingsUpdate({ enterToSend: false, enterToSendConfigured: false })).toEqual({
      enterToSend: false,
      enterToSendConfigured: false,
    });
    expect(helpers.sanitizeSettingsUpdate({ enterToSend: 'true' })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ enterToSend: 1 })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ enterToSendConfigured: 'true' })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ enterToSendConfigured: 1 })).toEqual({});
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

    it('persists only boolean system prompt optimization values', () => {
      const helpers = createTestHelpersWithRealSanitizers();

      expect(helpers.sanitizeSettingsUpdate({ optimizeSystemPrompt: true })).toEqual({ optimizeSystemPrompt: true });
      expect(helpers.sanitizeSettingsUpdate({ optimizeSystemPrompt: false })).toEqual({ optimizeSystemPrompt: false });
      expect(helpers.sanitizeSettingsUpdate({ optimizeSystemPrompt: 'true' })).toEqual({});
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

  describe('session retention settings persistence', () => {
    it('round-trips sessionRetentionAction archive and delete through the sanitizer', () => {
      const helpers = createTestHelpersWithRealSanitizers();

      expect(helpers.sanitizeSettingsUpdate({ sessionRetentionAction: 'archive' })).toEqual({
        sessionRetentionAction: 'archive',
      });
      expect(helpers.sanitizeSettingsUpdate({ sessionRetentionAction: 'delete' })).toEqual({
        sessionRetentionAction: 'delete',
      });
    });

    it('rejects invalid sessionRetentionAction values', () => {
      const helpers = createTestHelpersWithRealSanitizers();

      expect(helpers.sanitizeSettingsUpdate({ sessionRetentionAction: 'remove' })).toEqual({});
      expect(helpers.sanitizeSettingsUpdate({ sessionRetentionAction: true })).toEqual({});
    });

    it('survives a full settings payload containing sessionRetentionAction (regression)', () => {
      const helpers = createTestHelpersWithRealSanitizers();
      const payload = {
        autoDeleteEnabled: true,
        autoDeleteAfterDays: 60,
        sessionRetentionAction: 'delete',
      };

      const sanitized = helpers.sanitizeSettingsUpdate(payload);

      expect(sanitized.autoDeleteEnabled).toBe(true);
      expect(sanitized.autoDeleteAfterDays).toBe(60);
      expect(sanitized.sessionRetentionAction).toBe('delete');
    });
  });
});
