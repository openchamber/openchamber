import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedConfigRuntime, MANAGED_CONFIG_FILE_NAME } from './managed-config-file.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const DENIAL = { action: 'integration.use', resource: 'plugin:leakshield', effect: 'deny' };

const createHarness = async ({ settings = {}, env = {}, listExtensionSkillDirectories, listExtensionPluginDirectories, openchamberVersion, readPluginDenials } = {}) => {
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
    listExtensionSkillDirectories,
    listExtensionPluginDirectories,
    openchamberVersion,
    readPluginDenials,
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
      skills: [path.join(dataDir, 'skills')],
      commands: { 'new-extension': { description: expect.any(String), template: expect.stringContaining(path.join(dataDir, 'skills', 'openchamber-extensions', 'SKILL.md')) } },
    });
  });

  it('writes the extension-writing skill where OpenCode can scan it, out of the agent\'s own reach', async () => {
    const { dataDir, runtime } = await createHarness({ settings: {} });
    await runtime.buildManagedChildEnv();
    const skill = await fs.readFile(path.join(dataDir, 'skills', 'openchamber-extensions', 'SKILL.md'), 'utf8');
    expect(skill).toContain('disable-model-invocation: true');
  });

  it.each([
    ['2.6.1', '2.6.1', '2.6.1'],
    ['2.6.2-canary.20261105.7', '2.6.2-canary.20261105.7', '2.6.2'],
    ['unknown', 'latest', '0.0.0'],
  ])('pins the extension-writing skill to app %s', async (openchamberVersion, sdkVersion, engineFloor) => {
    const { dataDir, runtime } = await createHarness({ settings: {}, openchamberVersion });
    await runtime.buildManagedChildEnv();
    const skill = await fs.readFile(path.join(dataDir, 'skills', 'openchamber-extensions', 'SKILL.md'), 'utf8');
    expect(skill).toContain(`bun add @openchamber/sdk@${sdkVersion}\``);
    expect(skill).toContain(`"@openchamber/sdk": "${sdkVersion}"`);
    expect(skill).toContain(`"openchamber": ">=${engineFloor}"`);
    expect(skill).not.toContain('{{');
  });

  it('lists the skill folders of active extensions and leaves them out once none is', async () => {
    const skills = { current: ['/pkg/skills'] };
    const { dataDir, runtime, readConfigFile } = await createHarness({ settings: {}, listExtensionSkillDirectories: async () => skills.current });
    await runtime.buildManagedChildEnv();
    expect((await readConfigFile()).skills).toEqual([path.join(dataDir, 'skills'), '/pkg/skills']);
    skills.current = [];
    await runtime.refreshManagedConfigFile();
    expect((await readConfigFile()).skills).toEqual([path.join(dataDir, 'skills')]);
  });

  it('lists the plugin folders of active extensions after its own plugins and drops them once none is', async () => {
    const plugins = { current: ['/pkg/plugin'] };
    const { dataDir, runtime, readConfigFile, titleDirectory } = await createHarness({ settings: {}, listExtensionPluginDirectories: async () => plugins.current });
    await runtime.buildManagedChildEnv();
    expect((await readConfigFile()).plugins).toEqual(['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool'), titleDirectory, '/pkg/plugin']);
    plugins.current = [];
    await runtime.refreshManagedConfigFile();
    expect((await readConfigFile()).plugins).toEqual(['-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool'), titleDirectory]);
  });

  it('merges extension plugin folders into OPENCODE_CONFIG_CONTENT when the user owns OPENCODE_CONFIG', async () => {
    const { dataDir, runtime, titleDirectory } = await createHarness({
      settings: {},
      env: { OPENCODE_CONFIG: '/home/user/opencode.json', OPENCODE_CONFIG_CONTENT: '{"plugins":["/pkg/plugin"]}' },
      listExtensionPluginDirectories: async () => ['/pkg/plugin'],
    });
    const childEnv = await runtime.buildManagedChildEnv();
    // The user's own copy of the same folder is not listed twice; ours come after OpenChamber's.
    expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT).plugins).toEqual([
      '-opencode.browser', path.join(dataDir, 'agent-tool', 'openchamber-agent-tool'), titleDirectory, '/pkg/plugin',
    ]);
  });

  it('runs one read-then-write at a time, so the file ends with the newest catalog', async () => {
    // The first refresh reads a catalog that still lists the plugin and is slow;
    // a pause then triggers a second refresh whose read answers nothing. Written
    // in read order, the stale list would land last and bring the plugin back.
    let release;
    const slowRead = new Promise((resolve) => { release = resolve; });
    const reads = [];
    const { runtime, readConfigFile } = await createHarness({
      settings: {},
      listExtensionPluginDirectories: async () => {
        reads.push(reads.length);
        if (reads.length === 1) { await slowRead; return ['/pkg/plugin']; }
        return [];
      },
    });
    const first = runtime.refreshManagedConfigFile();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = runtime.refreshManagedConfigFile();
    release();
    await Promise.all([first, second]);
    expect((await readConfigFile()).plugins).not.toContain('/pkg/plugin');
    // The joined request ran the read once more rather than writing beside the first.
    expect(reads.length).toBe(2);
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
    });
    const readConfig = async () => JSON.parse(await fs.readFile(path.join(dataDir, MANAGED_CONFIG_FILE_NAME), 'utf8'));

    await runtime.buildManagedChildEnv();
    expect((await readConfig()).plugins).toEqual(['-opencode.browser', titleDirectory]);

    current.settings = { ...toolsOff, accountSwitchProviders: ['anthropic'] };
    await runtime.refreshManagedConfigFile();
    expect((await readConfig()).plugins).toEqual(['-opencode.browser', failoverDirectory, titleDirectory]);

    current.settings = { ...toolsOff, fallbackModel: 'openai/gpt-5.6' };
    await runtime.refreshManagedConfigFile();
    expect((await readConfig()).plugins).toEqual(['-opencode.browser', failoverDirectory, titleDirectory]);

    current.settings = { ...toolsOff, accountSwitchProviders: [] };
    await runtime.refreshManagedConfigFile();
    expect((await readConfig()).plugins).toEqual(['-opencode.browser', titleDirectory]);
  });

  it('keeps the callback token in the child env while every tool is off', async () => {
    const { runtime, agentToolRuntime, readConfigFile, titleDirectory } = await createHarness({
      settings: { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentMemoryToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false },
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(agentToolRuntime.materializePlugin).not.toHaveBeenCalled();
    expect((await readConfigFile()).plugins).toEqual(['-opencode.browser', titleDirectory]);
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
      skills: [path.join(dataDir, 'skills')],
      commands: { 'new-extension': expect.any(Object) },
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

  it('injects the memory tool only once the user turns it on', async () => {
    const toolsOff = { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false };
    const unset = await createHarness({ settings: toolsOff });
    await unset.runtime.buildManagedChildEnv();
    expect(unset.agentToolRuntime.materializePlugin).not.toHaveBeenCalled();

    const on = await createHarness({ settings: { ...toolsOff, agentMemoryToolEnabled: true } });
    await on.runtime.buildManagedChildEnv();
    expect(on.agentToolRuntime.materializePlugin).toHaveBeenCalledWith(expect.objectContaining({ includeMemory: true }));
  });

  it('injects the workflow tool only once the user turns it on', async () => {
    const toolsOff = { agentControlToolEnabled: false, agentScheduleToolEnabled: false, agentWebToolEnabled: false, agentKnowledgeToolEnabled: false, agentRenderToolEnabled: false, agentSecretToolEnabled: false };
    const unset = await createHarness({ settings: toolsOff });
    await unset.runtime.buildManagedChildEnv();
    expect(unset.agentToolRuntime.materializePlugin).not.toHaveBeenCalled();

    const present = await createHarness({ settings: { ...toolsOff, agentWorkflowToolEnabled: true } });
    await present.runtime.buildManagedChildEnv();
    expect(present.agentToolRuntime.materializePlugin).toHaveBeenCalledWith(expect.objectContaining({ includeWorkflow: true }));
    // The answer tool is denied everywhere; a workflow agent's session allows it.
    expect((await present.readConfigFile()).permissions).toEqual([{ action: 'openchamber_workflow_answer', resource: '*', effect: 'deny' }]);

    present.current.settings = { ...toolsOff, agentWorkflowToolEnabled: false };
    await present.runtime.refreshManagedConfigFile();
    expect((await present.readConfigFile()).plugins).toEqual(['-opencode.browser', present.titleDirectory]);
  });

  it('denies the plugins switched off in OpenChamber, without touching the plugin list', async () => {
    const { runtime, readConfigFile, titleDirectory, agentToolRuntime } = await createHarness({
      settings: {},
      readPluginDenials: () => [DENIAL],
    });

    await runtime.buildManagedChildEnv();

    expect(await readConfigFile()).toMatchObject({
      plugins: ['-opencode.browser', agentToolRuntime.pluginDirectory, titleDirectory],
      policies: [DENIAL],
    });
  });

  it('refuses a launch when the switched-off plugins cannot be established', async () => {
    const { runtime, dataDir } = await createHarness({
      settings: {},
      readPluginDenials: () => { throw new Error('unreadable store'); },
    });

    await expect(runtime.buildManagedChildEnv()).rejects.toThrow('unreadable store');
    await expect(fs.access(path.join(dataDir, MANAGED_CONFIG_FILE_NAME))).rejects.toThrow();
  });

  it('refuses a launch on the fallback path too', async () => {
    const { runtime } = await createHarness({
      settings: {},
      env: { OPENCODE_CONFIG: '/home/user/opencode.json' },
      readPluginDenials: () => { throw new Error('unreadable store'); },
    });

    await expect(runtime.buildManagedChildEnv()).rejects.toThrow('unreadable store');
  });

  it('keeps the published denials when a later rewrite cannot read them', async () => {
    let readDenials = () => [DENIAL];
    const { runtime, readConfigFile } = await createHarness({ settings: {}, readPluginDenials: () => readDenials() });
    await runtime.refreshManagedConfigFile();

    readDenials = () => { throw new Error('unreadable store'); };

    await expect(runtime.refreshManagedConfigFile()).rejects.toThrow('unreadable store');
    expect((await readConfigFile()).policies).toEqual([DENIAL]);
  });

  it('appends the same denials to OPENCODE_CONFIG_CONTENT', async () => {
    const { runtime, titleDirectory, agentToolRuntime } = await createHarness({
      settings: {},
      env: { OPENCODE_CONFIG: '/home/user/opencode.json', OPENCODE_CONFIG_CONTENT: '{"model":"test/model"}' },
      readPluginDenials: () => [DENIAL],
    });

    const childEnv = await runtime.buildManagedChildEnv();

    expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT)).toMatchObject({
      model: 'test/model',
      plugins: ['-opencode.browser', agentToolRuntime.pluginDirectory, titleDirectory],
      policies: [DENIAL],
    });
  });
});
