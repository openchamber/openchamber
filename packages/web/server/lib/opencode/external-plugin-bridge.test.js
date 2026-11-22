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
  registerExternalPluginBridgeRoutes,
} from './external-plugin-bridge.js';

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
  let contextHook = null;
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
        if (name === 'context') contextHook = fn;
      },
      get: async () => ({ permissions: sessionPermissions }),
      context: async () => [],
    },
    event: {
      subscribe: () => (async function* () {})(),
    },
    provider: { get: async () => ({ data: {} }) },
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
    getContextHook: () => contextHook,
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
      expect(active.removed).toContain('automation_create');
      expect(mock.runAgentTransform('Native title')).not.toBe('Native title');

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
    const app = express();
    registerExternalPluginBridgeRoutes(app, {
      getBridge: () => runtime,
      getDelivery: () => 'none',
      readGlobalEntries: () => ({ path: '/tmp/opencode.json', targets: [...globalTargets] }),
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
    });

    const added = await request(app).post('/api/config/external-opencode-plugin/global-config').expect(200);
    expect(added.body).toEqual({
      path: '/tmp/opencode.json',
      added: true,
      pluginPath: runtime.pluginDirectory,
    });

    const afterAdd = await request(app).get('/api/config/external-opencode-plugin').expect(200);
    expect(afterAdd.body.bridgeActive).toBe(true);

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
      const contextHook = mock.getContextHook();
      const ordinaryDraft = { sessionID: 'ses_ordinary', tools: { openchamber_workflow_answer: { description: 'x' }, openchamber_workflow: { description: 'y' } } };
      await contextHook(ordinaryDraft);
      expect(ordinaryDraft.tools).not.toHaveProperty('openchamber_workflow_answer');
      expect(ordinaryDraft.tools).toHaveProperty('openchamber_workflow');

      mock.setSessionPermissions([{ action: 'openchamber_workflow_answer', resource: '*', effect: 'allow' }]);
      const workflowDraft = { sessionID: 'ses_workflow', tools: { openchamber_workflow_answer: { description: 'x' } } };
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
