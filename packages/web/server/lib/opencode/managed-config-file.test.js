import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedConfigRuntime, MANAGED_CONFIG_FILE_NAME } from './managed-config-file.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createHarness = async ({ settings = {}, env = {}, memoryAvailable = true, managed } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-managed-config-'));
  temporaryDirectories.push(dataDir);
  const agentToolRuntime = {
    pluginDirectory: path.join(dataDir, 'agent-tool', 'openchamber-agent-tool'),
    materializePlugin: vi.fn(async (flags) => {
      await fs.mkdir(agentToolRuntime.pluginDirectory, { recursive: true });
      await fs.writeFile(path.join(agentToolRuntime.pluginDirectory, 'flags.json'), JSON.stringify(flags));
      return agentToolRuntime.pluginDirectory;
    }),
    createChildEnv: vi.fn(() => ({
      OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:3901/api/openchamber/agent-tool',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'token',
    })),
  };
  const current = { settings };
  const runtime = createManagedConfigRuntime({
    fsPromises: fs,
    path,
    instanceDir: dataDir,
    env,
    agentToolRuntime,
    readSettings: () => current.settings,
    isAgentMemoryAvailable: () => memoryAvailable,
    // Undefined leaves the runtime's own default in place.
    isManagedOpenCode: managed === undefined ? undefined : () => managed,
  });
  const readConfigFile = async () => JSON.parse(await fs.readFile(path.join(dataDir, MANAGED_CONFIG_FILE_NAME), 'utf8'));
  return { dataDir, runtime, agentToolRuntime, current, readConfigFile };
};

describe('managed OpenCode config file', () => {
  it('points the child at a config file listing the enabled plugins', async () => {
    const { dataDir, runtime, readConfigFile } = await createHarness({
      settings: {},
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBe(path.join(dataDir, MANAGED_CONFIG_FILE_NAME));
    expect(childEnv.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(childEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('token');
    expect(await readConfigFile()).toEqual({
      plugins: ['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool')],
    });
  });

  it('materializes every listed plugin directory before naming it', async () => {
    const { runtime, readConfigFile } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();

    for (const directory of (await readConfigFile()).plugins.filter((entry) => !entry.startsWith('-'))) {
      expect((await fs.stat(directory)).isDirectory()).toBe(true);
    }
  });

  it('keeps the callback token in the child env while every tool is off', async () => {
    const { runtime, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentMemoryToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect(await readConfigFile()).toEqual({ plugins: ['-opencode.browser'] });
    // A tool switched on later reaches a process that can already call back.
    expect(childEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('token');
  });

  it('rewrites the file when a tool is turned off, without a new token', async () => {
    const { dataDir, runtime, current, agentToolRuntime, readConfigFile } = await createHarness({
      settings: {},
    });
    await runtime.buildManagedChildEnv();

    current.settings = { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false };
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: true });

    const { plugins } = await readConfigFile();
    expect(plugins).toEqual(['-opencode.browser']);
    expect(agentToolRuntime.createChildEnv).toHaveBeenCalledTimes(1);
  });

  it('turns a tool back on without a restart', async () => {
    const { runtime, current, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false },
    });
    await runtime.buildManagedChildEnv();

    current.settings = { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: true, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false };
    await runtime.refreshManagedConfigFile();

    expect((await readConfigFile()).plugins).toHaveLength(2);
    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeControl: false,
      includeSchedule: false,
      includeWeb: true,
      includeMemory: false,
      includeKnowledge: false,
      includeNotify: false,
      includeRender: false,
      codeMode: false,
    });
  });

  it('injects the knowledge tool by default and leaves it out once switched off', async () => {
    const { runtime, current, agentToolRuntime } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();
    expect(agentToolRuntime.materializePlugin).toHaveBeenLastCalledWith(expect.objectContaining({ includeKnowledge: true }));

    current.settings = { agentKnowledgeToolEnabled: false };
    await runtime.refreshManagedConfigFile();
    expect(agentToolRuntime.materializePlugin).toHaveBeenLastCalledWith(expect.objectContaining({ includeKnowledge: false }));
  });

  it('injects the schedule tool by default and leaves it out once switched off', async () => {
    const { runtime, current, agentToolRuntime } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();
    expect(agentToolRuntime.materializePlugin).toHaveBeenLastCalledWith(expect.objectContaining({ includeSchedule: true }));

    current.settings = { agentScheduleToolEnabled: false };
    await runtime.refreshManagedConfigFile();
    expect(agentToolRuntime.materializePlugin).toHaveBeenLastCalledWith(expect.objectContaining({ includeControl: true, includeSchedule: false }));
  });

  it('injects the render tool by default and leaves it out once switched off', async () => {
    const { runtime, current, agentToolRuntime } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();
    expect(agentToolRuntime.materializePlugin).toHaveBeenLastCalledWith(expect.objectContaining({ includeRender: true }));

    current.settings = { agentRenderToolEnabled: false };
    await runtime.refreshManagedConfigFile();
    expect(agentToolRuntime.materializePlugin).toHaveBeenLastCalledWith(expect.objectContaining({ includeRender: false }));
  });

  it('injects the notify tool only when it is switched on', async () => {
    const { runtime, agentToolRuntime } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentNotifyToolEnabled: true },
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeControl: false,
      includeSchedule: false,
      includeWeb: false,
      includeMemory: false,
      includeKnowledge: false,
      includeNotify: true,
      includeRender: false,
      codeMode: false,
    });
  });

  it('puts the tools behind Code Mode only when the user asks for it', async () => {
    const { runtime, agentToolRuntime } = await createHarness({
      settings: { agentToolsCodeMode: true },
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeControl: true,
      includeSchedule: true,
      includeWeb: true,
      includeMemory: false,
      includeKnowledge: true,
      includeNotify: false,
      includeRender: true,
      codeMode: true,
    });
  });

  it('leaves a config file the user owns alone and keeps the restart requirement', async () => {
    const { dataDir, runtime } = await createHarness({
      settings: {},
      env: { OPENCODE_CONFIG: '/home/user/opencode.json', OPENCODE_CONFIG_CONTENT: '{"model":"test/model"}' },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBeUndefined();
    expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'test/model',
      plugins: ['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool')],
    });
    await expect(fs.stat(path.join(dataDir, MANAGED_CONFIG_FILE_NAME))).rejects.toThrow();
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: false, reason: 'external-config' });
  });

  // The Tools settings page shows its prompt cache note only when this is true, because
  // only then does a switch change the running session's tool list (PR #306 review).
  it('reports that tool switches apply live only for a launched OpenCode reading our config file', async () => {
    expect((await createHarness({ managed: true })).runtime.appliesLive()).toBe(true);
    expect((await createHarness({ managed: false })).runtime.appliesLive()).toBe(false);
    expect((await createHarness({})).runtime.appliesLive()).toBe(false);
    const userConfig = await createHarness({ managed: true, env: { OPENCODE_CONFIG: '/home/user/opencode.json' } });
    expect(userConfig.runtime.appliesLive()).toBe(false);
  });

  it('leaves no temp file behind and never publishes a partial list', async () => {
    const { dataDir, runtime } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();
    await runtime.refreshManagedConfigFile();

    const entries = await fs.readdir(dataDir);
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    expect(entries).toContain(MANAGED_CONFIG_FILE_NAME);
  });

  it('ignores the memory tool while the feature is unavailable', async () => {
    const { runtime, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentMemoryToolEnabled: true },
      memoryAvailable: false,
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect(await readConfigFile()).toEqual({ plugins: ['-opencode.browser'] });
  });
});
