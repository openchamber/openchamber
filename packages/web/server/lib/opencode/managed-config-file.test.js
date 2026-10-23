import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedConfigRuntime, MANAGED_CONFIG_FILE_NAME } from './managed-config-file.js';

const temporaryDirectories = [];
const localMcpDirectory = (dataDir) => path.join(dataDir, 'mcp-project-local', 'plugin');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

// The data dir and the instance dir are separate folders, as in production
// (`<data-dir>/run/instances/<pid>`), so a test fails when one stands in for the other.
const createHarness = async ({ settings = {}, env = {}, memoryAvailable = true, botAvailable = false } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-managed-config-'));
  temporaryDirectories.push(root);
  const dataDir = path.join(root, 'data');
  const instanceDir = path.join(root, 'instance');
  const agentToolRuntime = {
    pluginDirectory: path.join(instanceDir, 'agent-tool', 'openchamber-agent-tool'),
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
    dataDir,
    instanceDir,
    env,
    agentToolRuntime,
    readSettings: () => current.settings,
    isAgentMemoryAvailable: () => memoryAvailable,
    isBotToolAvailable: () => botAvailable,
  });
  const readConfigFile = async () => JSON.parse(await fs.readFile(path.join(instanceDir, MANAGED_CONFIG_FILE_NAME), 'utf8'));
  return { dataDir, instanceDir, runtime, agentToolRuntime, current, readConfigFile };
};

const readLocalMcpPluginSource = (dataDir) => fs.readFile(path.join(localMcpDirectory(dataDir), 'index.js'), 'utf8');

describe('managed OpenCode config file', () => {
  it('keeps the item-only bot tool available when ordinary managed tools are off', async () => {
    // Given a bot-capable server with every optional session control disabled.
    const { runtime, agentToolRuntime, readConfigFile } = await createHarness({ botAvailable: true, settings: {
      agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false,
      agentMemoryToolEnabled: false, agentKnowledgeToolEnabled: false, agentNotifyToolEnabled: false, agentRenderToolEnabled: false,
    } });
    // When its managed child config is generated, the bot plugin is still present.
    await runtime.buildManagedChildEnv();
    expect((await readConfigFile()).plugins).toContain(agentToolRuntime.pluginDirectory);
    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeBot: true, includeControl: false, includeSchedule: false, includeWeb: false,
      includeMemory: false, includeKnowledge: false, includeNotify: false, includeRender: false, codeMode: false,
    });
  });

  it('points the child at a config file listing the enabled plugins', async () => {
    const { dataDir, instanceDir, runtime, readConfigFile } = await createHarness({
      settings: {},
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBe(path.join(instanceDir, MANAGED_CONFIG_FILE_NAME));
    expect(childEnv.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(childEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('token');
    expect(await readConfigFile()).toEqual({
      plugins: ['-opencode.browser', localMcpDirectory(dataDir), path.join(instanceDir, 'agent-tool', 'openchamber-agent-tool')],
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
    const { dataDir, runtime, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentMemoryToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect(await readConfigFile()).toEqual({ plugins: ['-opencode.browser', localMcpDirectory(dataDir)] });
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
    expect(plugins).toEqual(['-opencode.browser', localMcpDirectory(dataDir)]);
    expect(agentToolRuntime.createChildEnv).toHaveBeenCalledTimes(1);
  });

  it('turns a tool back on without a restart', async () => {
    const { runtime, current, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false },
    });
    await runtime.buildManagedChildEnv();

    current.settings = { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: true, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false };
    await runtime.refreshManagedConfigFile();

    expect((await readConfigFile()).plugins).toHaveLength(3);
    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeBot: false,
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
      includeBot: false,
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
      includeBot: false,
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
    const { dataDir, instanceDir, runtime } = await createHarness({
      settings: {},
      env: { OPENCODE_CONFIG: '/home/user/opencode.json', OPENCODE_CONFIG_CONTENT: '{"model":"test/model"}' },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBeUndefined();
    expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'test/model',
      plugins: ['-opencode.browser', localMcpDirectory(dataDir), path.join(instanceDir, 'agent-tool', 'openchamber-agent-tool')],
    });
    await expect(fs.stat(path.join(instanceDir, MANAGED_CONFIG_FILE_NAME))).rejects.toThrow();
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: false, reason: 'external-config' });
  });

  it('leaves no temp file behind and never publishes a partial list', async () => {
    const { instanceDir, runtime } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();
    await runtime.refreshManagedConfigFile();

    const entries = await fs.readdir(instanceDir);
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    expect(entries).toContain(MANAGED_CONFIG_FILE_NAME);
  });

  it('ignores the memory tool while the feature is unavailable', async () => {
    const { dataDir, runtime, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentMemoryToolEnabled: true },
      memoryAvailable: false,
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect(await readConfigFile()).toEqual({ plugins: ['-opencode.browser', localMcpDirectory(dataDir)] });
  });

  it('reads project-local MCP entries from the data dir on spawn and on refresh', async () => {
    const { dataDir, instanceDir, runtime, current, readConfigFile } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();
    expect((await readConfigFile()).plugins[1]).toBe(localMcpDirectory(dataDir));
    expect(await readLocalMcpPluginSource(dataDir)).toContain(`dataDir: ${JSON.stringify(dataDir)}`);

    current.settings = { agentWebToolEnabled: false };
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: true });
    expect((await readConfigFile()).plugins[1]).toBe(localMcpDirectory(dataDir));
    expect(await readLocalMcpPluginSource(dataDir)).toContain(`dataDir: ${JSON.stringify(dataDir)}`);

    // Per-process files stay in the instance dir; the persistent entries never move there.
    await expect(fs.stat(path.join(instanceDir, 'mcp-project-local'))).rejects.toThrow();
    await expect(fs.stat(path.join(dataDir, MANAGED_CONFIG_FILE_NAME))).rejects.toThrow();
  });

  it('refuses to build without both directories', () => {
    const dependencies = {
      fsPromises: fs,
      path,
      dataDir: '/data',
      instanceDir: '/data/run/instances/1',
      readSettings: () => ({}),
      isAgentMemoryAvailable: () => false,
    };

    expect(() => createManagedConfigRuntime({ ...dependencies, dataDir: undefined })).toThrow(/dataDir/);
    expect(() => createManagedConfigRuntime({ ...dependencies, instanceDir: 'relative' })).toThrow(/instanceDir/);
    expect(() => createManagedConfigRuntime(dependencies)).not.toThrow();
  });
});
