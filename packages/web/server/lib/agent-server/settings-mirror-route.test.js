import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createAgentMemoryRuntime } from '../agent-memory/runtime.js';
import { createMemoryDreaming } from '../agent-memory/dreaming.js';
import { createUsageReadAction } from '../openchamber-control/usage-read.js';
import { createHiddenSessionRegistry } from '../opencode/hidden-sessions.js';
import { createManagedConfigRuntime } from '../opencode/managed-config-file.js';
import { createSettingsHelpers } from '../opencode/settings-helpers.js';
import { createSettingsNormalizationRuntime } from '../opencode/settings-normalization-runtime.js';
import { createSettingsRuntime } from '../opencode/settings-runtime.js';
import { registerSettingsRoutes } from '../opencode/routes.js';
import { createSettingsMirror, pickAgentSettings } from './settings-mirror.js';

const EXECUTOR_PREFERENCES = {
  agentUsageToolEnabled: true,
  agentMemoryDreamingEnabled: true,
  agentMemoryDreamingModel: 'openrouter/team/model',
  agentMemoryDreamingVariant: 'high',
  sessionRetentionIncludeInWork: true,
};

const createRuntime = (root, callbacks = {}) => {
  const normalization = createSettingsNormalizationRuntime({ os, path, processLike: process });
  const helpers = createSettingsHelpers({
    ...normalization, normalizeTunnelProvider: (value) => value, normalizeTunnelMode: (value) => value,
    normalizeOptionalPath: (value) => value,
  });
  return createSettingsRuntime({
    ...normalization, ...helpers, ...callbacks,
    fsPromises: fs, path, crypto, SETTINGS_FILE_PATH: path.join(root, 'settings.json'),
    resolveDirectoryCandidate: (value) => value,
  });
};

const agentApp = (runtime, agentServer = true) => {
  const app = express();
  app.use(express.json());
  registerSettingsRoutes(app, { ...runtime, agentServer });
  return app;
};

const mirrorTo = (app) => createSettingsMirror({ upstream: {
  json: async (url, options) => {
    const response = await request(app).put(url).set(options.headers).send(JSON.parse(options.body));
    expect(response.status).toBe(200);
    return response.body;
  },
} });

it.each([false, true])('replaces absent mirror keys only on an agent server (%s)', async (agentServer) => {
  const root = await fs.mkdtemp('/tmp/opencode/mirror-route-');
  const runtime = createRuntime(root);
  try {
    // Given stale mirrored fields whose ordinary sanitizer has no clear value,
    // alongside revoked session policy and a private agent-only field.
    await runtime.writeSettingsToDisk({ ...EXECUTOR_PREFERENCES,
      githubClientId: 'stale', lastSelectedModel: 'stale', lastUsedEfforts: { model: 'high' },
      permissionAutoAccept: { sessions: { ses_agent: 'ask' }, revision: 2 }, agentOnly: 'kept' });
    const app = agentApp(runtime, agentServer);
    // When a full owner mirror snapshot no longer carries those preferences.
    const response = await request(app).put('/api/config/settings').set('x-openchamber-settings-mirror', '1').send(pickAgentSettings({ locale: 'pt-BR' }));
    expect(response.status).toBe(200);
    const restarted = await createRuntime(root).readSettingsFromDiskMigrated();
    for (const key of ['githubClientId', 'lastSelectedModel', 'lastUsedEfforts', ...Object.keys(EXECUTOR_PREFERENCES)]) {
      if (agentServer) expect(restarted).not.toHaveProperty(key);
      else expect(restarted).toHaveProperty(key);
    }
    // Then agent runtime state and non-mirrored settings remain untouched.
    expect(restarted.permissionAutoAccept.sessions.ses_agent).toBe('ask');
    expect(restarted.agentOnly).toBe('kept');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('applies executor preferences, false and empty resets, then first-start omission through the real agent consumers', async () => {
  const root = await fs.mkdtemp('/tmp/opencode/mirror-executor-');
  try {
    const pluginDirectory = path.join(root, 'instance', 'agent-tool');
    const flagsFile = path.join(pluginDirectory, 'flags.json');
    const agent = createRuntime(root, { onManagedPluginSettingsChanged: () => managed.refreshManagedConfigFile() });
    const managed = createManagedConfigRuntime({
      fsPromises: fs, path, dataDir: root, instanceDir: path.join(root, 'instance'), env: {},
      readSettings: () => agent.readSettingsFromDiskMigrated(),
      agentToolRuntime: { materializePlugin: async (flags) => {
        await fs.mkdir(pluginDirectory, { recursive: true });
        await fs.writeFile(flagsFile, JSON.stringify(flags));
        return pluginDirectory;
      } },
    });
    const agentState = { permissionAutoAccept: { revision: 2, sessions: { ses_agent: 'ask' } }, agentOnly: 'kept' };
    await agent.writeSettingsToDisk(agentState);
    const app = agentApp(agent);
    const mirror = mirrorTo(app);
    const quota = {
      listUsagePageProviders: () => [{ providerId: 'test', providerName: 'Test' }],
      listConfiguredQuotaProviders: async () => ['test'],
      fetchQuotaForProvider: vi.fn(async () => ({ providerId: 'test', ok: true, usage: { remaining: 50 } })),
    };
    const usage = createUsageReadAction({ readSettings: () => agent.readSettingsFromDiskMigrated(), loadQuota: async () => quota });

    await mirror.start(EXECUTOR_PREFERENCES);
    expect(await createRuntime(root).readSettingsFromDisk()).toMatchObject(EXECUTOR_PREFERENCES);
    expect((await usage()).providers).toEqual([{ providerId: 'test', ok: true, usage: { remaining: 50 } }]);
    expect(JSON.parse(await fs.readFile(flagsFile, 'utf8')).includeUsage).toBe(true);

    const reset = {
      agentUsageToolEnabled: false, agentMemoryDreamingEnabled: false, sessionRetentionIncludeInWork: false,
      agentMemoryDreamingModel: '', agentMemoryDreamingVariant: '',
    };
    await mirror.onSettingsWritten(reset);
    expect(await agent.readSettingsFromDisk()).toMatchObject(reset);
    await expect(usage()).rejects.toMatchObject({ statusCode: 403 });
    expect(quota.fetchQuotaForProvider).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(flagsFile, 'utf8')).includeUsage).toBe(false);

    // Stale disk values must clear even when this front door has never sent a snapshot.
    await agent.writeSettingsToDisk({ ...agentState, ...EXECUTOR_PREFERENCES });
    await mirrorTo(app).start({});
    const restarted = await createRuntime(root).readSettingsFromDisk();
    for (const key of ['agentUsageToolEnabled', 'agentMemoryDreamingEnabled', 'sessionRetentionIncludeInWork']) {
      expect(restarted).not.toHaveProperty(key);
    }
    expect(restarted.agentMemoryDreamingModel).toBe('');
    expect(restarted.agentMemoryDreamingVariant).toBe('');
    expect(restarted).toMatchObject(agentState);
    await expect(usage()).rejects.toMatchObject({ statusCode: 403 });
    expect(JSON.parse(await fs.readFile(flagsFile, 'utf8')).includeUsage).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('dreams with mirrored model and variant, restores the default model on clear, and stops on false or omission', async () => {
  const root = await fs.mkdtemp('/tmp/opencode/mirror-dreaming-');
  try {
    const directory = path.join(root, 'project');
    await fs.mkdir(directory);
    const agent = createRuntime(root);
    const app = agentApp(agent);
    const mirror = mirrorTo(app);
    const owner = {
      ...EXECUTOR_PREFERENCES, agentMemoryToolEnabled: true, projects: [{ id: 'project', path: directory }],
      agentMemoryDreamingModel: ' openrouter/team/model ', agentMemoryDreamingVariant: ' high ',
    };
    await mirror.start(owner);
    const projectId = (await agent.readSettingsFromDisk()).projects[0].id;
    const memory = createAgentMemoryRuntime({ fsPromises: fs, path, userConfigRoot: root, projectsDirPath: path.join(root, 'projects') });
    const target = { scope: 'project', projectId };
    for (let index = 0; index < 10; index += 1) {
      await memory.create(target, { title: `Fact ${index}`, body: `Project detail ${index}` });
    }
    const models = [];
    let active = null;
    const dreaming = createMemoryDreaming({
      agentMemoryRuntime: memory, readSettings: () => agent.readSettingsFromDiskMigrated(),
      resolveProjectId: async () => projectId, measureIndex: () => ({ budget: 8000, used: 100, omitted: 0 }),
      hiddenSessions: createHiddenSessionRegistry(),
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`, getOpenCodeAuthHeaders: () => ({}),
      resolveSessionDefaults: () => ({ providerID: 'default', modelID: 'model', variant: 'low' }),
      pollIntervalMs: 1,
      setTimer: (callback, ms) => { if (ms === 1) queueMicrotask(callback); }, clearTimer: () => {},
      fetchImpl: async (url, init) => {
        const { pathname } = new URL(url);
        const json = (data) => Response.json({ data });
        if (pathname === '/api/session/active') {
          const data = active ? { [active]: { type: 'running' } } : {};
          active = null;
          return json(data);
        }
        if (pathname === '/api/session' && init.method === 'POST') {
          models.push(JSON.parse(init.body).model);
          return json({ id: `ses_dream_${models.length}` });
        }
        if (pathname.endsWith('/prompt')) active = pathname.split('/')[3];
        if (pathname.endsWith('/message')) return json([{ type: 'assistant', content: [{ type: 'text', text: 'Done.' }] }]);
        return json([]);
      },
      log: () => {},
    });
    await dreaming.check();
    expect(models).toEqual([{ providerID: 'openrouter', id: 'team/model', variant: 'high' }]);

    // Keep a pass due so disabled checks cannot pass just because the last pass ran.
    await memory.recordDream(target, { lastRunAt: null, record: null, snapshot: null });
    await mirror.onSettingsWritten({ ...owner, agentMemoryDreamingVariant: '' });
    await dreaming.check();
    expect(models.at(-1)).toEqual({ providerID: 'openrouter', id: 'team/model' });

    await memory.recordDream(target, { lastRunAt: null, record: null, snapshot: null });
    await mirror.onSettingsWritten({ ...owner, agentMemoryDreamingModel: '', agentMemoryDreamingVariant: '' });
    await dreaming.check();
    expect(models).toEqual([
      { providerID: 'openrouter', id: 'team/model', variant: 'high' },
      { providerID: 'openrouter', id: 'team/model' },
      { providerID: 'default', id: 'model', variant: 'low' },
    ]);

    await memory.recordDream(target, { lastRunAt: null, record: null, snapshot: null });
    await mirror.onSettingsWritten({ ...owner, agentMemoryDreamingEnabled: false });
    await dreaming.check();
    await agent.writeSettingsToDisk({ ...await agent.readSettingsFromDisk(), ...EXECUTOR_PREFERENCES });
    await mirrorTo(app).start({ agentMemoryToolEnabled: true, projects: owner.projects });
    await dreaming.check();
    expect(models).toHaveLength(3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
