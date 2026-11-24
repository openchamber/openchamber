import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXTERNAL_BRIDGE_FILE_NAME,
  collectSkillEntriesFromRoots,
  createExternalPluginBridgeRuntime,
  isBridgePluginLoaded,
  registerExternalPluginBridgeRoutes,
} from './external-plugin-bridge.js';
import { canonicalPluginPath } from './plugin-paths.js';

const tempDirs = [];
let savedAgentToolUrl;

const createTempDir = async (prefix) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

beforeEach(() => {
  savedAgentToolUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
  delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
});

afterEach(async () => {
  if (savedAgentToolUrl === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
  else process.env.OPENCHAMBER_AGENT_TOOL_URL = savedAgentToolUrl;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const createMockPluginContext = (initialTools = []) => {
  let toolTransform = null;
  let agentTransform = null;
  let retryHook = null;
  let promptHook = null;
  const requestHooks = {};
  let titleHook = null;
  let toolReloads = 0;
  let agentReloads = 0;
  let sessionPermissions = [];

  const runToolTransform = () => {
    const added = {};
    const removed = [];
    const namespaces = [];
    const editor = {
      list: () => initialTools,
      namespace: (ns) => namespaces.push(ns),
      add: (tool) => { added[tool.name] = tool; },
      remove: (id) => { removed.push(id); },
    };
    if (toolTransform) toolTransform(editor);
    return { added, removed, namespaces };
  };

  const runAgentTransform = (originalSystem = 'Original OpenCode title prompt') => {
    const titleAgent = { id: 'title', system: originalSystem };
    const editor = {
      get: (id) => (id === 'title' ? titleAgent : undefined),
      update: (id, fn) => {
        if (id === 'title') fn(titleAgent);
      },
    };
    if (agentTransform) agentTransform(editor);
    return titleAgent.system;
  };

  const ctx = {
    tool: {
      transform: async (fn) => { toolTransform = fn; },
      reload: async () => { toolReloads += 1; },
    },
    agent: {
      transform: async (fn) => { agentTransform = fn; },
      reload: async () => { agentReloads += 1; },
    },
    session: {
      hook: async (name, fn) => {
        if (name === 'retry') retryHook = fn;
        if (name === 'prompt') promptHook = fn;
        (requestHooks[name] ??= []).push(fn);
        if (name === 'title') titleHook = fn;
      },
      get: async () => ({ permissions: sessionPermissions }),
      context: async () => [],
    },
    event: {
      subscribe: () => (async function* () {})(),
    },
    provider: { get: async () => ({ data: {} }) },
    // big-pickle is free on Zen without a -free suffix.
    model: {
      list: async () => ({
        data: [{ providerID: 'opencode', id: 'big-pickle', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }],
      }),
    },
    integration: {
      get: async () => ({ data: { connections: [] } }),
      connection: { active: async () => undefined },
    },
  };

  return {
    ctx,
    runToolTransform,
    runAgentTransform,
    getRetryHook: () => retryHook,
    getPromptHook: () => promptHook,
    getRequestHook: (name) => async (draft) => { for (const hook of requestHooks[name] ?? []) await hook(draft); },
    runTitleHook: async (system, model = { providerID: 'opencode', id: 'big-pickle' }) => {
      const draft = {
        sessionID: 'ses_1',
        model,
        system: [{ type: 'text', text: system }],
        messages: [{ role: 'user', content: [{ type: 'text', text: '<message>\nExplain what an API endpoint is.\n</message>' }] }],
        options: {},
      };
      await titleHook(draft);
      return draft;
    },
    setSessionPermissions: (rules) => { sessionPermissions = rules; },
    getReloadCounts: () => ({ toolReloads, agentReloads }),
  };
};

describe('external-plugin-bridge', () => {
  it('stays dormant when closed, activates tools and hides builtins when running, and restores on close', async () => {
    const dataDir = await createTempDir('oc-ext-bridge-');
    let settings = {
      agentControlToolEnabled: true,
      agentScheduleToolEnabled: true,
      agentWebToolEnabled: true,
      agentRenderToolEnabled: true,
      agentSecretToolEnabled: true,
      agentImageToolEnabled: true,
      agentKnowledgeToolEnabled: false,
      agentMemoryToolEnabled: false,
      agentNotifyToolEnabled: false,
      agentUsageToolEnabled: false,
      agentTerminalToolEnabled: false,
      agentWorkflowToolEnabled: false,
    };
    let externalLocal = true;

    const runtime = createExternalPluginBridgeRuntime({
      fsPromises: fs,
      path,
      dataDir,
      readSettings: () => settings,
      ensureCredentials: () => ({ url: 'http://127.0.0.1:41234/api/openchamber/agent-tool', token: 'bridge-secret-token' }),
      isExternalLocal: () => externalLocal,
    });

    const pluginDir = await runtime.materializePlugin();
    const mod = await import(`${path.join(pluginDir, 'index.js')}?t=${Date.now()}`);
    const builtinTools = [
      { id: 'browser_open', options: { namespace: 'browser' } },
      { id: 'browser_tab_click', options: { namespace: 'browser.tab' } },
      { id: 'opencode_worktree_create', options: { namespace: 'opencode' } },
      { id: 'opencode_models', options: { namespace: 'opencode' } },
      { id: 'experimental_image_generate', options: {} },
      { id: 'generate_image', options: {} },
      { id: 'automation_create', options: {} },
    ];
    const mock = createMockPluginContext(builtinTools);
    const cleanup = await mod.default.setup(mock.ctx);

    try {
      // 1. Bridge file absent -> completely dormant.
      const before = mock.runToolTransform();
      expect(Object.keys(before.added)).toEqual([]);
      expect(before.removed).toEqual([]);
      expect(mock.runAgentTransform('Native title')).toBe('Native title');

      // 2. OpenChamber writes bridge file -> tools appear, builtins hidden, title prompt active.
      const syncResult = await runtime.syncBridge();
      expect(syncResult).toEqual({ active: true });
      expect(runtime.isActive()).toBe(true);

      await vi.waitFor(() => {
        expect(mock.getReloadCounts().toolReloads).toBeGreaterThanOrEqual(1);
        expect(mock.getReloadCounts().agentReloads).toBeGreaterThanOrEqual(1);
      });

      const active = mock.runToolTransform();
      expect(active.added).toHaveProperty('openchamber');
      expect(active.added).toHaveProperty('openchamber_schedule');
      expect(active.added).toHaveProperty('openchamber_web');
      expect(active.added).toHaveProperty('openchamber_render');
      expect(active.added).toHaveProperty('openchamber_secret');
      expect(active.added).toHaveProperty('openchamber_image');
      expect(active.added).not.toHaveProperty('openchamber_knowledge');
      expect(active.removed).toContain('browser_open');
      expect(active.removed).toContain('browser_tab_click');
      expect(active.removed).toContain('opencode_worktree_create');
      expect(active.removed).toContain('opencode_models');
      expect(active.removed).toContain('experimental_image_generate');
      expect(active.removed).toContain('generate_image');
      expect(active.removed).toContain('automation_create');
      const styledTitleSystem = mock.runAgentTransform('Native title');
      expect(styledTitleSystem).not.toBe('Native title');
      // A free Zen model without the -free suffix keeps the native prompt and gets the style in its input.
      const bigPickleDraft = await mock.runTitleHook(styledTitleSystem);
      expect(bigPickleDraft.system[0].text).toBe('Native title');
      expect(bigPickleDraft.messages.at(-1).content.at(-1).text).toBe(styledTitleSystem);

      // 3. Settings change disables image tool -> reload fires and image builtin is no longer removed.
      const reloadsBeforeToggle = mock.getReloadCounts().toolReloads;
      settings = { ...settings, agentImageToolEnabled: false };
      await runtime.syncBridge();
      await vi.waitFor(() => {
        expect(mock.getReloadCounts().toolReloads).toBeGreaterThan(reloadsBeforeToggle);
      });
      const afterToggle = mock.runToolTransform();
      expect(afterToggle.added).not.toHaveProperty('openchamber_image');
      expect(afterToggle.removed).not.toContain('experimental_image_generate');

      // 4. Managed OpenCode child env suppresses external plugin even while bridge file exists.
      const savedUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
      process.env.OPENCHAMBER_AGENT_TOOL_URL = 'http://127.0.0.1:9999/api/openchamber/agent-tool';
      try {
        const suppressed = mock.runToolTransform();
        expect(Object.keys(suppressed.added)).toEqual([]);
        expect(suppressed.removed).toEqual([]);
      } finally {
        if (savedUrl === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
        else process.env.OPENCHAMBER_AGENT_TOOL_URL = savedUrl;
      }

      // 5. OpenChamber closes -> cleanup removes bridge file, watcher reloads, builtins return.
      const reloadsBeforeClose = mock.getReloadCounts();
      await runtime.cleanupBridge();
      await vi.waitFor(() => {
        expect(mock.getReloadCounts().toolReloads).toBeGreaterThan(reloadsBeforeClose.toolReloads);
        expect(mock.getReloadCounts().agentReloads).toBeGreaterThan(reloadsBeforeClose.agentReloads);
      });
      const afterClose = mock.runToolTransform();
      expect(Object.keys(afterClose.added)).toEqual([]);
      expect(afterClose.removed).toEqual([]);
      expect(mock.runAgentTransform('Native title')).toBe('Native title');
      const closedDraft = await mock.runTitleHook(styledTitleSystem);
      expect(closedDraft.system[0].text).toBe(styledTitleSystem);
      expect(closedDraft.messages.at(-1).content).toHaveLength(1);
    } finally {
      await cleanup?.();
    }
  });

  it('ignores a stale bridge file whose pid is dead', async () => {
    const dataDir = await createTempDir('oc-ext-dead-pid-');
    const runtime = createExternalPluginBridgeRuntime({
      fsPromises: fs,
      path,
      dataDir,
      pid: 99999999,
      readSettings: () => ({ agentControlToolEnabled: true }),
      ensureCredentials: () => ({ url: 'http://127.0.0.1:41234/api/openchamber/agent-tool', token: 'tok' }),
      isExternalLocal: () => true,
    });
    const pluginDir = await runtime.materializePlugin();
    await runtime.syncBridge();
    const raw = await fs.readFile(path.join(dataDir, EXTERNAL_BRIDGE_FILE_NAME), 'utf8');
    expect(JSON.parse(raw).pid).toBe(99999999);

    const mod = await import(`${path.join(pluginDir, 'index.js')}?t=${Date.now()}`);
    const mock = createMockPluginContext([{ id: 'browser_open', options: { namespace: 'browser' } }]);
    const cleanup = await mod.default.setup(mock.ctx);
    try {
      const result = mock.runToolTransform();
      expect(Object.keys(result.added)).toEqual([]);
      expect(result.removed).toEqual([]);
    } finally {
      await cleanup?.();
    }
  });

  it('proves to the OpenChamber holding its token, and only to it, that it is loaded in a location', async () => {
    const dataDir = await createTempDir('oc-ext-proof-');
    const runtime = createExternalPluginBridgeRuntime({
      fsPromises: fs,
      path,
      dataDir,
      readSettings: () => ({ agentControlToolEnabled: true }),
      ensureCredentials: () => ({ url: 'http://127.0.0.1:41234/api/openchamber/agent-tool', token: 'bridge-secret-token' }),
      isExternalLocal: () => true,
    });
    const pluginDir = await runtime.materializePlugin();
    const mod = await import(`${path.join(pluginDir, 'index.js')}?t=${Date.now()}`);
    const mock = createMockPluginContext();
    const registered = new Map();
    mock.ctx.rpc = { register: async (definition, handlers) => { registered.set(definition.id, handlers); } };
    const cleanup = await mod.default.setup(mock.ctx);

    // OpenCode's answers as the client throws them: an RpcError carries its type.
    const location = (handlersById) => ({
      plugin: { list: async () => ({ data: [{ id: 'opencode.agent' }] }) },
      rpc: {
        call: async ({ rpcID, method, input }) => {
          const handler = handlersById.get(rpcID)?.[method];
          if (!handler) throw Object.assign(new Error('RPC is unavailable'), { type: 'rpc.unavailable' });
          return { output: await handler(input) };
        },
      },
    });

    try {
      expect(await isBridgePluginLoaded(location(registered), 'bridge-secret-token')).toBe(false);

      await runtime.syncBridge();
      expect(runtime.readActiveToken()).toBe('bridge-secret-token');
      expect(await isBridgePluginLoaded(location(registered), 'bridge-secret-token')).toBe(true);
      expect(await isBridgePluginLoaded(location(registered), 'another-openchamber-token')).toBe(false);
      expect(await isBridgePluginLoaded(location(new Map()), 'bridge-secret-token')).toBe(false);

      // Mid-reload: OpenCode lists the plugin before its setup registered the RPC again.
      const reloading = { ...location(new Map()), plugin: { list: async () => ({ data: [{ id: 'opencode.agent' }, { id: 'openchamber' }] }) } };
      expect(await isBridgePluginLoaded(reloading, 'bridge-secret-token')).toBe(null);

      const unreachable = { ...location(registered), rpc: { call: async () => { throw new TypeError('fetch failed'); } } };
      expect(await isBridgePluginLoaded(unreachable, 'bridge-secret-token')).toBe(null);
    } finally {
      await cleanup?.();
      await runtime.cleanupBridge();
    }
  });

  it('serves GET, POST, and DELETE routes for registering and removing the plugin in global config', async () => {
    const dataDir = await createTempDir('oc-ext-routes-');
    const runtime = createExternalPluginBridgeRuntime({
      fsPromises: fs,
      path,
      dataDir,
      readSettings: () => ({ agentControlToolEnabled: true }),
      ensureCredentials: () => ({ url: 'http://127.0.0.1:41234/api/openchamber/agent-tool', token: 'tok' }),
      isExternalLocal: () => true,
    });

    const globalTargets = new Set();
    const askedDirectories = [];
    const app = express();
    registerExternalPluginBridgeRoutes(app, {
      getBridge: () => runtime,
      getDelivery: () => 'none',
      isLoadedIn: async (directory) => { askedDirectories.push(directory); return false; },
      readGlobalEntries: () => ({ path: '/tmp/opencode.json', targets: [...globalTargets].map(canonicalPluginPath) }),
      addGlobalEntry: (dir) => {
        const added = !globalTargets.has(dir);
        globalTargets.add(dir);
        return { path: '/tmp/opencode.json', added };
      },
      removeGlobalEntry: (dir) => {
        const removed = globalTargets.delete(dir);
        return { path: '/tmp/opencode.json', removed };
      },
    });

    const initial = await request(app).get('/api/config/external-opencode-plugin').expect(200);
    expect(initial.body).toEqual({
      delivery: 'none',
      pluginPath: runtime.pluginDirectory,
      globalConfigPath: '/tmp/opencode.json',
      inGlobalConfig: false,
      bridgeActive: false,
      loadedInDirectory: null,
    });

    const added = await request(app).post('/api/config/external-opencode-plugin/global-config').expect(200);
    expect(added.body).toEqual({
      path: '/tmp/opencode.json',
      added: true,
      pluginPath: runtime.pluginDirectory,
    });

    const afterAdd = await request(app).get('/api/config/external-opencode-plugin').expect(200);
    expect(afterAdd.body.bridgeActive).toBe(true);
    expect(afterAdd.body.loadedInDirectory).toBe(null);
    const inProject = await request(app).get('/api/config/external-opencode-plugin').query({ directory: '/work/app' }).expect(200);
    expect(inProject.body.loadedInDirectory).toBe(false);
    expect(askedDirectories).toEqual(['/work/app']);

    const removed = await request(app).delete('/api/config/external-opencode-plugin/global-config').expect(200);
    expect(removed.body).toEqual({
      path: '/tmp/opencode.json',
      removed: true,
    });
  });

  it('prevents an in-flight sync from recreating the bridge file after cleanup', async () => {
    const dataDir = await createTempDir('oc-ext-shutdown-race-');
    let releaseSettings;
    const settingsPromise = new Promise((resolve) => { releaseSettings = resolve; });
    const runtime = createExternalPluginBridgeRuntime({
      fsPromises: fs,
      path,
      dataDir,
      readSettings: () => settingsPromise,
      ensureCredentials: () => ({ url: 'http://127.0.0.1:41234/api/openchamber/agent-tool', token: 'tok' }),
      isExternalLocal: () => true,
    });

    const pendingSync = runtime.syncBridge();
    const pendingCleanup = runtime.cleanupBridge();
    releaseSettings({ agentControlToolEnabled: true });

    const [syncResult] = await Promise.all([pendingSync, pendingCleanup]);
    expect(syncResult).toEqual({ active: false });
    expect(runtime.isActive()).toBe(false);
    await expect(fs.stat(path.join(dataDir, EXTERNAL_BRIDGE_FILE_NAME))).rejects.toThrow();
  });

  it('refuses to overwrite a bridge owned by another live OpenChamber process', async () => {
    const dataDir = await createTempDir('oc-ext-two-instances-');
    const first = createExternalPluginBridgeRuntime({
      fsPromises: fs,
      path,
      dataDir,
      pid: process.pid,
      readSettings: () => ({ agentControlToolEnabled: true }),
      ensureCredentials: () => ({ url: 'http://127.0.0.1:41001/api/openchamber/agent-tool', token: 'first-token' }),
      isExternalLocal: () => true,
    });
    const second = createExternalPluginBridgeRuntime({
      fsPromises: fs,
      path,
      dataDir,
      pid: process.ppid,
      readSettings: () => ({ agentControlToolEnabled: true }),
      ensureCredentials: () => ({ url: 'http://127.0.0.1:41002/api/openchamber/agent-tool', token: 'second-token' }),
      isExternalLocal: () => true,
    });

    expect(await first.syncBridge()).toEqual({ active: true });
    expect(await second.syncBridge()).toEqual({ active: false });
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, EXTERNAL_BRIDGE_FILE_NAME), 'utf8'));
    expect(stored.token).toBe('first-token');
    expect(stored.pid).toBe(process.pid);
  });

  it.each([
    ['system-update', true, 2],
    ['system-reminder', true, 2],
    ['system-update', false, 1],
  ])('follows the Plan mode %s with where plans are saved, knowledge tool on: %s', async (tag, enabled, count) => {
    const dataDir = await createTempDir('oc-ext-plan-note-');
    const runtime = createExternalPluginBridgeRuntime({
      fsPromises: fs,
      path,
      dataDir,
      readSettings: () => ({ agentKnowledgeToolEnabled: enabled }),
      ensureCredentials: () => ({ url: 'http://127.0.0.1:41234/api/openchamber/agent-tool', token: 'tok' }),
      isExternalLocal: () => true,
    });
    const pluginDir = await runtime.materializePlugin();
    await runtime.syncBridge();

    const mod = await import(`${path.join(pluginDir, 'index.js')}?t=${Date.now()}`);
    const mock = createMockPluginContext();
    const cleanup = await mod.default.setup(mock.ctx);
    try {
      const reminder = { role: 'user', content: [{ type: 'text', text: `<${tag}>\nYou are in Plan mode. Discuss.\n</${tag}>` }] };
      for (const hook of ['context', 'compaction', 'generate']) {
        const draft = { sessionID: 'ses_plan', messages: [reminder], tools: {} };
        await mock.getRequestHook(hook)(draft);
        expect(draft.messages).toHaveLength(count);
        expect(draft.messages[0]).toBe(reminder);
      }
    } finally {
      await cleanup?.();
    }
  });

  it('hides openchamber_workflow_answer from ordinary sessions while allowing workflow schema sessions', async () => {
    const dataDir = await createTempDir('oc-ext-workflow-answer-');
    const runtime = createExternalPluginBridgeRuntime({
      fsPromises: fs,
      path,
      dataDir,
      readSettings: () => ({ agentWorkflowToolEnabled: true }),
      ensureCredentials: () => ({ url: 'http://127.0.0.1:41234/api/openchamber/agent-tool', token: 'tok' }),
      isExternalLocal: () => true,
    });
    const pluginDir = await runtime.materializePlugin();
    await runtime.syncBridge();

    const mod = await import(`${path.join(pluginDir, 'index.js')}?t=${Date.now()}`);
    const mock = createMockPluginContext();
    const cleanup = await mod.default.setup(mock.ctx);
    try {
      const contextHook = mock.getRequestHook('context');
      const ordinaryDraft = { sessionID: 'ses_ordinary', messages: [], tools: { openchamber_workflow_answer: { description: 'x' }, openchamber_workflow: { description: 'y' } } };
      await contextHook(ordinaryDraft);
      expect(ordinaryDraft.tools).not.toHaveProperty('openchamber_workflow_answer');
      expect(ordinaryDraft.tools).toHaveProperty('openchamber_workflow');

      mock.setSessionPermissions([{ action: 'openchamber_workflow_answer', resource: '*', effect: 'allow' }]);
      const workflowDraft = { sessionID: 'ses_workflow', messages: [], tools: { openchamber_workflow_answer: { description: 'x' } } };
      await contextHook(workflowDraft);
      expect(workflowDraft.tools).toHaveProperty('openchamber_workflow_answer');
    } finally {
      await cleanup?.();
    }
  });

  it('registers extension skills and commands while active and clears them on close', async () => {
    const dataDir = await createTempDir('oc-ext-skills-');
    const skillsRoot = await createTempDir('oc-ext-skill-root-');
    const skillDir = path.join(skillsRoot, 'my-ext-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: My Extension Skill\ndescription: Helps with extension tasks\n---\nFollow these steps.',
      'utf8',
    );

    const collected = await collectSkillEntriesFromRoots(fs, path, [skillsRoot]);
    expect(collected).toEqual([
      expect.objectContaining({
        id: 'my-ext-skill',
        name: 'My Extension Skill',
        description: 'Helps with extension tasks',
        content: 'Follow these steps.',
      }),
    ]);

    const runtime = createExternalPluginBridgeRuntime({
      fsPromises: fs,
      path,
      dataDir,
      readSettings: () => ({ agentControlToolEnabled: true }),
      ensureCredentials: () => ({ url: 'http://127.0.0.1:41234/api/openchamber/agent-tool', token: 'tok' }),
      isExternalLocal: () => true,
      collectSkillsAndCommands: async () => ({
        skills: collected,
        commands: [{ name: 'new-extension', description: 'Build an OpenChamber extension', template: 'Build: $ARGUMENTS' }],
      }),
    });

    const pluginDir = await runtime.materializePlugin();
    const mod = await import(`${path.join(pluginDir, 'index.js')}?t=${Date.now()}`);
    let skillTransform = null;
    let commandTransform = null;
    let skillReloads = 0;
    let commandReloads = 0;
    const prompts = [];
    const mock = createMockPluginContext();
    const ctx = {
      ...mock.ctx,
      skill: {
        transform: async (fn) => { skillTransform = fn; },
        reload: async () => { skillReloads += 1; },
      },
      command: {
        transform: async (fn) => { commandTransform = fn; },
        reload: async () => { commandReloads += 1; },
      },
      session: {
        ...mock.ctx.session,
        prompt: async (input) => { prompts.push(input); },
      },
    };

    const cleanup = await mod.default.setup(ctx);
    try {
      await runtime.syncBridge();
      await vi.waitFor(() => {
        expect(skillReloads).toBeGreaterThanOrEqual(1);
        expect(commandReloads).toBeGreaterThanOrEqual(1);
      });

      const addedSkills = [];
      skillTransform({ add: (s) => addedSkills.push(s) });
      expect(addedSkills).toHaveLength(1);
      expect(addedSkills[0].id).toBe('my-ext-skill');

      const addedCommands = [];
      commandTransform({ add: (c) => addedCommands.push(c) });
      expect(addedCommands).toHaveLength(1);
      expect(addedCommands[0].name).toBe('new-extension');
      await addedCommands[0].execute({ sessionID: 'ses_1', prompt: { text: ' weather widget ' }, delivery: 'steer' });
      expect(prompts).toEqual([{ sessionID: 'ses_1', text: 'Build: weather widget', delivery: 'steer' }]);

      const reloadsBeforeClose = { skillReloads, commandReloads };
      await runtime.cleanupBridge();
      await vi.waitFor(() => {
        expect(skillReloads).toBeGreaterThan(reloadsBeforeClose.skillReloads);
        expect(commandReloads).toBeGreaterThan(reloadsBeforeClose.commandReloads);
      });
      const afterSkills = [];
      const afterCommands = [];
      skillTransform({ add: (s) => afterSkills.push(s) });
      commandTransform({ add: (c) => afterCommands.push(c) });
      expect(afterSkills).toEqual([]);
      expect(afterCommands).toEqual([]);
    } finally {
      await cleanup?.();
    }
  });
});
