import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsHelpers } from '../opencode/settings-helpers.js';
import { createSettingsNormalizationRuntime } from '../opencode/settings-normalization-runtime.js';
import { createSettingsRuntime } from '../opencode/settings-runtime.js';
import {
  AGENT_SETTINGS_MIRROR_KEYS_V1, AGENT_SETTINGS_MIRROR_VERSION, createSettingsMirror, pickAgentSettings,
} from './settings-mirror.js';

const createAgentRuntime = (settingsFilePath) => {
  const normalization = createSettingsNormalizationRuntime({ os, path, processLike: process });
  const helpers = createSettingsHelpers({
    ...normalization, normalizeTunnelProvider: (value) => value, normalizeTunnelMode: (value) => value,
    normalizeOptionalPath: (value) => value,
  });
  return createSettingsRuntime({
    ...normalization, ...helpers, fsPromises: fs, path, crypto, SETTINGS_FILE_PATH: settingsFilePath,
    resolveDirectoryCandidate: (value) => value, syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
  });
};

describe('agent settings mirror', () => {
  it('uses an explicit versioned allowlist without registry secrets or front-door state', () => {
    const registry = createRequire(import.meta.url)('../opencode/settings-registry.json');
    expect(AGENT_SETTINGS_MIRROR_VERSION).toBe(1);
    expect(Object.isFrozen(AGENT_SETTINGS_MIRROR_KEYS_V1)).toBe(true);
    expect(new Set(AGENT_SETTINGS_MIRROR_KEYS_V1).size).toBe(AGENT_SETTINGS_MIRROR_KEYS_V1.length);
    expect(AGENT_SETTINGS_MIRROR_KEYS_V1).not.toContain('permissionAutoAccept');
    for (const key of AGENT_SETTINGS_MIRROR_KEYS_V1) expect(registry.fields[key]?.secret).not.toBe(true);
    const picked = pickAgentSettings({
      ...Object.fromEntries(Object.entries(registry.fields).filter(([, field]) => field.secret).map(([key]) => [key, 'bait'])),
      locale: 'uk', permissionDefaultMode: 'ask', agentWebToolEnabled: false,
      desktopUiPassword: 'bait', managedRemoteTunnelToken: 'bait', managedRemoteTunnelPresetTokens: { a: 'bait' },
      relayPrivateKey: 'bait', uiPassword: 'bait', protectedMcp: { token: 'bait' }, isolatedSpacesEnabled: true,
      notificationTemplates: { completion: { message: 'bait' } }, reportUsage: true, serverUpdateChannel: 'canary',
      environment: { SECRET: 'bait' }, unknownFutureKey: 'bait', homeDirectory: '/front-door', agentBrowserSharesLogins: true,
    });
    expect(picked).toEqual({ locale: 'uk', permissionDefaultMode: 'ask', agentWebToolEnabled: false });
    expect(JSON.stringify(picked)).not.toContain('bait');
  });

  it.each([true, false])('projects the reviewed executor preference shapes including %s switches', (enabled) => {
    const preferences = {
      agentUsageToolEnabled: enabled, agentMemoryDreamingEnabled: enabled, sessionRetentionIncludeInWork: enabled,
      agentMemoryDreamingModel: 'openrouter/team/model', agentMemoryDreamingVariant: 'high',
    };
    expect(pickAgentSettings(preferences)).toEqual(preferences);
    expect(pickAgentSettings({
      agentUsageToolEnabled: String(enabled), agentMemoryDreamingEnabled: 1, sessionRetentionIncludeInWork: null,
      agentMemoryDreamingModel: { apiKey: 'bait' }, agentMemoryDreamingVariant: ['bait'],
    })).toEqual({});
  });

  it('reconstructs nested project and runtime settings without copying unknown secret fields', () => {
    const source = {
      projects: [{ id: 'a', path: '/human/repo', label: 'Repo', defaultModel: 'p/m',
        secrets: { key: 'bait' }, environment: { SECRET: 'bait' }, iconImage: { token: 'bait' } }],
      accountSwitchProviders: ['p', { secret: 'bait' }],
      permissionAutoAccept: { revision: 3, token: 'bait', sessions: { ses_1: 'ask', bad: { token: 'bait' } } },
      lastUsedEfforts: { 'p/m': null, 'p/n': 'high', bad: { token: 'bait' } },
      prFixLoopDefaults: { watch: true, tokenBudget: null, allowAuthors: ['user', { token: 'bait' }], apiKey: 'bait' },
      defaultModel: { key: 'bait' }, agentImageToolEnabled: { key: 'bait' }, sessionGoalDefaultBudget: Infinity,
    };
    expect(pickAgentSettings(source)).toEqual({
      projects: [{ id: 'a', path: '/human/repo', label: 'Repo', defaultModel: 'p/m' }], accountSwitchProviders: ['p'],
      lastUsedEfforts: { 'p/m': null, 'p/n': 'high' },
      prFixLoopDefaults: { watch: true, tokenBudget: null, allowAuthors: ['user'] },
    });
  });

  it('mirrors startup and every successful owner notification and ignores the agent answer', async () => {
    const upstream = { json: vi.fn(async () => ({ desktopUiPassword: 'agent-controlled', projects: [] })) };
    const settings = { locale: 'uk', projects: [{ id: 'a', path: '/human/repo' }] };
    const mirror = createSettingsMirror({ upstream });
    await mirror.start(settings);
    await mirror.onSettingsWritten({ ...settings, agentWebToolEnabled: false });
    for (const [url, options] of upstream.json.mock.calls) {
      expect(url).toBe('/api/config/settings');
      expect(options).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/json' } });
    }
    const sent = upstream.json.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(sent[0]).toMatchObject(settings);
    expect(sent[1]).toEqual({ ...sent[0], agentWebToolEnabled: false });
    expect(settings).toEqual({ locale: 'uk', projects: [{ id: 'a', path: '/human/repo' }] });
  });

  it('captures clones on enqueue and serializes later snapshots behind startup', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let sending;
    const started = new Promise((resolve) => { sending = resolve; });
    const upstream = { json: vi.fn().mockImplementationOnce(async () => { sending(); await gate; }).mockResolvedValue({}) };
    const mirror = createSettingsMirror({ upstream });
    const startup = mirror.start({ locale: 'en' });
    await started;
    const settings = { locale: 'uk', projects: [{ id: 'a', path: '/first' }], accountSwitchProviders: ['first'] };
    const first = mirror.onSettingsWritten(settings);
    settings.locale = 'fr';
    settings.projects[0].path = '/second';
    settings.accountSwitchProviders[0] = 'second';
    const second = mirror.onSettingsWritten(settings);
    settings.projects[0].path = '/mutated-after-enqueue';
    expect(upstream.json).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([startup, first, second, mirror.flush()]);
    const sent = upstream.json.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(sent[0]).toMatchObject({ locale: 'en' });
    expect(sent.slice(1)).toEqual([
      { ...sent[0], locale: 'uk', projects: [{ id: 'a', path: '/first' }], accountSwitchProviders: ['first'] },
      { ...sent[0], locale: 'fr', projects: [{ id: 'a', path: '/second' }], accountSwitchProviders: ['second'] },
    ]);
  });

  it('sends the front door\'s own origins for the agent\'s Server Browser to refuse, and nothing when they cannot be made', async () => {
    const upstream = { json: vi.fn(async () => ({})) };
    const ownOrigins = vi.fn(async (settings) => [`http://127.0.0.1:41731`, ...(settings.publicOrigin ? [settings.publicOrigin] : [])]);
    const mirror = createSettingsMirror({ upstream, ownOrigins });
    await mirror.start({ locale: 'uk', publicOrigin: 'https://chamber.example.com', serverBrowserOpenChamberOrigins: ['https://agent-chosen.example'] });
    const [sent] = upstream.json.mock.calls.map(([, options]) => JSON.parse(options.body));
    // The front door decides the list; the setting itself only reaches the agent through it.
    expect(sent.serverBrowserOpenChamberOrigins).toEqual(['http://127.0.0.1:41731', 'https://chamber.example.com']);
    expect(AGENT_SETTINGS_MIRROR_KEYS_V1).toContain('serverBrowserOpenChamberOrigins');
    const logger = { warn: vi.fn() };
    const failing = createSettingsMirror({ upstream, logger, ownOrigins: async () => ['javascript:alert(1)'] });
    await failing.start({ locale: 'uk' });
    expect(upstream.json).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls).toEqual([['agent_settings_mirror_failed']]);
  });

  it('recovers the queue after failures and logs only fixed error codes', async () => {
    const upstream = { json: vi.fn().mockRejectedValueOnce(Object.assign(new Error('secret cookie'), { code: 'secret token' })).mockResolvedValue({}) };
    const logger = { warn: vi.fn() };
    const mirror = createSettingsMirror({ upstream, logger });
    await expect(mirror.start({ locale: 'uk' })).resolves.toBeUndefined();
    await mirror.onSettingsWritten({ locale: 'fr' });
    expect(logger.warn.mock.calls).toEqual([['agent_settings_mirror_failed']]);
    expect(upstream.json).toHaveBeenCalledTimes(2);
  });

  it('never sends legacy per-session auto state on unrelated saves or a fresh mirror start', async () => {
    const root = await fs.mkdtemp('/tmp/opencode/agent-session-policy-');
    try {
      const settingsFile = path.join(root, 'settings.json');
      const agent = createAgentRuntime(settingsFile);
      const revoked = { revision: 4, sessions: { ses_1: 'ask' } };
      await agent.writeSettingsToDisk({ permissionAutoAccept: revoked });
      const upstream = { json: vi.fn(async (_url, options) => agent.persistSettings(JSON.parse(options.body))) };
      const legacyOwner = { permissionDefaultMode: 'ask', permissionAutoAccept: { revision: 1, sessions: { ses_1: 'auto' } } };
      await createSettingsMirror({ upstream }).onSettingsWritten({ ...legacyOwner, locale: 'uk' });
      await createSettingsMirror({ upstream }).start(legacyOwner);
      for (const [, options] of upstream.json.mock.calls) {
        expect(JSON.parse(options.body)).not.toHaveProperty('permissionAutoAccept');
        expect(JSON.parse(options.body).permissionDefaultMode).toBe('ask');
      }
      const restarted = createAgentRuntime(settingsFile);
      expect((await restarted.readSettingsFromDisk()).permissionAutoAccept).toEqual(revoked);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('sends only sanitizer-supported clear values on the first snapshot without prior sent history', async () => {
    const upstream = { json: vi.fn(async () => {}) };
    await createSettingsMirror({ upstream }).start({});
    const payload = JSON.parse(upstream.json.mock.calls[0][1].body);
    expect(payload).toEqual({
      lastDirectory: '', opencodeBinary: '', defaultGitIdentityId: '', defaultModel: '', defaultVariant: '', defaultAgent: '',
      smallModelOverride: '', smallModelVariant: '', walkthroughModelOverride: '', walkthroughModelVariant: '',
      agentMemoryDreamingModel: '', agentMemoryDreamingVariant: '',
      fallbackModel: '', fallbackVariant: '', zenModel: '', globalBehaviorPrompt: '', responseStyleCustomInstructions: '',
      accountSwitchProviders: [], terminalLoginShells: [], favoriteAgents: [], recentAgents: [], providerOrder: [], projects: [],
      permissionDefaultMode: 'ask', prFixLoopDefaults: {}, serverBrowserOpenChamberOrigins: [],
    });
    const helpers = createSettingsHelpers({
      ...createSettingsNormalizationRuntime({ os, path, processLike: process }),
      normalizeTunnelProvider: (value) => value, normalizeTunnelMode: (value) => value, normalizeOptionalPath: (value) => value,
    });
    const sanitized = helpers.sanitizeSettingsUpdate(payload);
    for (const key of Object.keys(payload)) {
      expect(AGENT_SETTINGS_MIRROR_KEYS_V1).toContain(key);
      expect(Object.hasOwn(sanitized, key)).toBe(true);
    }
    for (const key of ['fallbackModel', 'defaultModel', 'defaultGitIdentityId', 'smallModelVariant', 'walkthroughModelVariant']) {
      expect(payload[key]).toBe('');
      expect(sanitized[key]).toBeUndefined();
    }
    expect(payload).not.toHaveProperty('permissionAutoAccept');
  });

  it('clears removed model overrides on saves and first startup through the real agent persistence', async () => {
    const root = await fs.mkdtemp('/tmp/opencode/agent-mirror-clears-');
    try {
      const settingsFile = path.join(root, 'settings.json');
      const agent = createAgentRuntime(settingsFile);
      const models = {
        fallbackModel: 'provider/stale', fallbackVariant: 'high', defaultModel: 'provider/stale', defaultVariant: 'high',
        defaultAgent: 'stale-agent', smallModelOverride: 'provider/stale', smallModelVariant: 'high',
        walkthroughModelOverride: 'provider/stale', walkthroughModelVariant: 'high', zenModel: 'provider/stale',
        defaultGitIdentityId: 'stale-identity', accountSwitchProviders: ['stale-provider'],
      };
      const upstream = { json: vi.fn(async (_url, options) => agent.persistSettings(JSON.parse(options.body))) };
      const mirror = createSettingsMirror({ upstream });
      await mirror.onSettingsWritten(models);
      expect(await agent.readSettingsFromDisk()).toMatchObject(models);
      await mirror.onSettingsWritten({ locale: 'uk' });
      const cleared = await agent.readSettingsFromDisk();
      for (const key of Object.keys(models).filter((key) => key !== 'accountSwitchProviders')) {
        expect(cleared).not.toHaveProperty(key);
      }
      expect(cleared.accountSwitchProviders).toEqual([]);
      await agent.writeSettingsToDisk(models);
      expect(await agent.readSettingsFromDisk()).toMatchObject(models);
      await createSettingsMirror({ upstream }).start({ locale: 'uk' });
      const restarted = createAgentRuntime(settingsFile);
      const afterRestart = await restarted.readSettingsFromDisk();
      for (const key of Object.keys(models).filter((key) => key !== 'accountSwitchProviders')) {
        expect(afterRestart).not.toHaveProperty(key);
      }
      expect(afterRestart.accountSwitchProviders).toEqual([]);
      expect(await fs.readFile(settingsFile, 'utf8')).not.toContain('provider/stale');
      expect(await fs.readFile(path.join(root, 'preferences.json'), 'utf8')).not.toContain('provider/stale');
      expect(JSON.parse(upstream.json.mock.calls.at(-1)[1].body)).toMatchObject({ fallbackModel: '', defaultModel: '', accountSwitchProviders: [] });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
