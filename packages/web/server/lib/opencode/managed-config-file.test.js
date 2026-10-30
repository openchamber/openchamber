import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedConfigRuntime, MANAGED_CONFIG_FILE_NAME } from './managed-config-file.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createHarness = async ({ settings = {}, env = {}, memoryAvailable = true, workflowAvailable = false } = {}) => {
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
  const titleDirectory = path.join(dataDir, 'session-title', 'openchamber-session-title');
  const current = { settings };
  const runtime = createManagedConfigRuntime({
    fsPromises: fs,
    path,
    instanceDir: dataDir,
    env,
    agentToolRuntime,
    readSettings: () => current.settings,
    isAgentMemoryAvailable: () => memoryAvailable,
    isWorkflowAvailable: () => workflowAvailable,
  });
  const readConfigFile = async () => JSON.parse(await fs.readFile(path.join(dataDir, MANAGED_CONFIG_FILE_NAME), 'utf8'));
  return { dataDir, runtime, agentToolRuntime, current, readConfigFile, titleDirectory };
};

describe('managed OpenCode config file', () => {
  it('points the child at a config file listing the enabled plugins', async () => {
    const { dataDir, runtime, readConfigFile, titleDirectory } = await createHarness({
      settings: {},
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBe(path.join(dataDir, MANAGED_CONFIG_FILE_NAME));
    expect(childEnv.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(childEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('token');
    expect(await readConfigFile()).toEqual({
      plugins: ['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool'), titleDirectory],
    });
  });

  it('materializes every listed plugin directory before naming it', async () => {
    const { runtime, readConfigFile } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();

    for (const directory of (await readConfigFile()).plugins.filter((entry) => !entry.startsWith('-'))) {
      expect((await fs.stat(directory)).isDirectory()).toBe(true);
    }
  });

  it('lists the limit failover plugin only while a fallback model or an account switch is set', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-managed-config-'));
    temporaryDirectories.push(dataDir);
    const failoverDirectory = path.join(dataDir, 'limit-failover', 'openchamber-limit-failover');
    const titleDirectory = path.join(dataDir, 'session-title', 'openchamber-session-title');
    const toolsOff = { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false };
    const current = { settings: toolsOff };
    const runtime = createManagedConfigRuntime({
      fsPromises: fs,
      path,
      instanceDir: dataDir,
      env: {},
      agentToolRuntime: { materializePlugin: vi.fn(), createChildEnv: () => ({}) },
      limitFailoverRuntime: { materializePlugin: vi.fn(async () => failoverDirectory) },
      readSettings: () => current.settings,
      isAgentMemoryAvailable: () => false,
    });
    const readConfig = async () => JSON.parse(await fs.readFile(path.join(dataDir, MANAGED_CONFIG_FILE_NAME), 'utf8'));

    await runtime.buildManagedChildEnv();
    expect(await readConfig()).toEqual({ plugins: ['-opencode.browser', titleDirectory] });

    current.settings = { ...toolsOff, accountSwitchProviders: ['anthropic'] };
    await runtime.refreshManagedConfigFile();
    expect(await readConfig()).toEqual({ plugins: ['-opencode.browser', failoverDirectory, titleDirectory] });

    current.settings = { ...toolsOff, fallbackModel: 'openai/gpt-5.6' };
    await runtime.refreshManagedConfigFile();
    expect(await readConfig()).toEqual({ plugins: ['-opencode.browser', failoverDirectory, titleDirectory] });

    current.settings = { ...toolsOff, accountSwitchProviders: [] };
    await runtime.refreshManagedConfigFile();
    expect(await readConfig()).toEqual({ plugins: ['-opencode.browser', titleDirectory] });
  });

  it('keeps the callback token in the child env while every tool is off', async () => {
    const { runtime, agentToolRuntime, readConfigFile, titleDirectory } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentMemoryToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect(await readConfigFile()).toEqual({ plugins: ['-opencode.browser', titleDirectory] });
    // A tool switched on later reaches a process that can already call back.
    expect(childEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('token');
  });

  it('rewrites the file when a tool is turned off, without a new token', async () => {
    const { dataDir, runtime, current, agentToolRuntime, readConfigFile, titleDirectory } = await createHarness({
      settings: {},
    });
    await runtime.buildManagedChildEnv();

    current.settings = { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false };
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: true });

    const { plugins } = await readConfigFile();
    expect(plugins).toEqual(['-opencode.browser', titleDirectory]);
    expect(agentToolRuntime.createChildEnv).toHaveBeenCalledTimes(1);
  });

  it('turns a tool back on without a restart', async () => {
    const { runtime, current, agentToolRuntime, readConfigFile } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false },
    });
    await runtime.buildManagedChildEnv();

    current.settings = { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: true, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false };
    await runtime.refreshManagedConfigFile();

    expect((await readConfigFile()).plugins).toHaveLength(3);
    expect(agentToolRuntime.materializePlugin).toHaveBeenCalledWith({
      includeControl: false,
      includeSchedule: false,
      includeWeb: true,
      includeMemory: false,
      includeKnowledge: false,
      includeNotify: false,
      includeRender: false,
      includeImage: false,
      includeSecret: false,
      includeWorkflow: false,
      codeMode: false,
    });
  });

  it('injects the image tool only when it is switched on, and then disables OpenCode\'s own', async () => {
    const { runtime, current, agentToolRuntime, readConfigFile } = await createHarness({ settings: {} });

    await runtime.buildManagedChildEnv();
    expect(agentToolRuntime.materializePlugin).toHaveBeenLastCalledWith(expect.objectContaining({ includeImage: false }));
    expect((await readConfigFile()).plugins).not.toContain('-opencode.tool.image-generate');

    current.settings = { agentImageToolEnabled: true };
    await runtime.refreshManagedConfigFile();
    expect(agentToolRuntime.materializePlugin).toHaveBeenLastCalledWith(expect.objectContaining({ includeImage: true }));
    expect((await readConfigFile()).plugins.slice(0, 2)).toEqual(['-opencode.browser', '-opencode.tool.image-generate']);
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
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false, agentNotifyToolEnabled: true },
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
      includeImage: false,
      includeSecret: false,
      includeWorkflow: false,
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
      includeImage: false,
      includeSecret: true,
      includeWorkflow: false,
      codeMode: true,
    });
  });

  it('leaves a config file the user owns alone and keeps the restart requirement', async () => {
    const { dataDir, runtime, titleDirectory } = await createHarness({
      settings: {},
      env: { OPENCODE_CONFIG: '/home/user/opencode.json', OPENCODE_CONFIG_CONTENT: '{"model":"test/model"}' },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(childEnv.OPENCODE_CONFIG).toBeUndefined();
    expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'test/model',
      plugins: ['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool'), titleDirectory],
    });
    await expect(fs.stat(path.join(dataDir, MANAGED_CONFIG_FILE_NAME))).rejects.toThrow();
    expect(await runtime.refreshManagedConfigFile()).toEqual({ updated: false, reason: 'external-config' });
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
    const { runtime, agentToolRuntime, readConfigFile, titleDirectory } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false, agentMemoryToolEnabled: true },
      memoryAvailable: false,
    });

    await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect(await readConfigFile()).toEqual({ plugins: ['-opencode.browser', titleDirectory] });
  });

  it('injects the workflow tool by default only in a build that has workflows', async () => {
    const toolsOff = { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false };
    const absent = await createHarness({ settings: toolsOff });
    await absent.runtime.buildManagedChildEnv();
    expect(absent.agentToolRuntime.materializePlugin).not.toHaveBeenCalled();

    const present = await createHarness({ settings: toolsOff, workflowAvailable: true });
    await present.runtime.buildManagedChildEnv();
    expect(present.agentToolRuntime.materializePlugin).toHaveBeenCalledWith(expect.objectContaining({ includeWorkflow: true }));
    // The answer tool is denied everywhere; a workflow agent's session allows it.
    expect((await present.readConfigFile()).permissions).toEqual([{ action: 'openchamber_workflow_answer', resource: '*', effect: 'deny' }]);

    present.current.settings = { ...toolsOff, agentWorkflowToolEnabled: false };
    await present.runtime.refreshManagedConfigFile();
    expect(await present.readConfigFile()).toEqual({ plugins: ['-opencode.browser', present.titleDirectory] });
  });
});
