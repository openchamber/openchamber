import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// shared.js freezes the OpenCode config directory at load, and skill discovery
// scans the home directory, so both point at a scratch tree before the module
// under test is imported. Nothing here may touch the real config or skills.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-integration-actions-')));
const originalHome = process.env.HOME;
process.env.HOME = path.join(root, 'home');
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
delete process.env.OPENCODE_CONFIG_DIR;
delete process.env.OPENCODE_CONFIG;
delete process.env.XDG_CACHE_HOME;

const {
  createIntegrationActions,
  matchesWildcard,
  readPolicyStatements,
  isIntegrationDenied,
  INTEGRATION_ACTION_DEFINITIONS,
  INTEGRATION_PARAMETERS,
} = await import('./integration-actions.js');
const { OpenChamberControlError } = await import('./error.js');

const userConfigPath = path.join(root, 'xdg', 'opencode', 'opencode.json');

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};
const writeJson = (filePath, value) => writeFile(filePath, JSON.stringify(value, null, 2));
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const writeSkill = (directory, id, frontmatter = {}) => {
  const lines = ['---', `name: ${frontmatter.name ?? id}`, `description: ${id} skill`];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key !== 'name') lines.push(`${key}: ${value}`);
  }
  const file = path.join(directory, '.opencode', 'skills', id, 'SKILL.md');
  writeFile(file, [...lines, '---', '', `Do ${id}.`, ''].join('\n'));
  return file;
};

const createClient = (overrides = {}) => ({
  mcp: {
    list: vi.fn(async () => ({ data: [] })),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    ...overrides.mcp,
  },
  config: { get: vi.fn(async () => []), ...overrides.config },
  skill: { list: vi.fn(async () => ({ data: [] })), ...overrides.skill },
});

let projectDir;

const createActions = ({ client = createClient(), settings = {}, getClient } = {}) => {
  let stored = { ...settings };
  const persistSettings = vi.fn(async (changes) => {
    stored = { ...stored, ...changes };
    return stored;
  });
  const actions = createIntegrationActions({
    readSettingsFromDiskMigrated: vi.fn(async () => stored),
    persistSettings,
  });
  const ctx = { contextDirectory: projectDir, contextSessionId: 'ses_1', getClient: getClient ?? vi.fn(async () => client) };
  return { actions, client, ctx, persistSettings };
};

const expectError = async (promise, statusCode, pattern) => {
  const error = await promise.then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(OpenChamberControlError);
  expect(error.statusCode).toBe(statusCode);
  if (pattern) expect(error.message).toMatch(pattern);
};

const doc = (file, policies) => ({ type: 'document', path: file, info: policies ? { experimental: { policies } } : {} });

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(root, 'project-'));
  fs.rmSync(path.join(root, 'xdg'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.XDG_CONFIG_HOME;
});

describe('integration action contract', () => {
  it('exports definitions, parameters and the action list in one order', () => {
    const { actions } = createActions();
    expect(actions.actions).toEqual(INTEGRATION_ACTION_DEFINITIONS.map(({ action }) => action));
    expect(Object.keys(INTEGRATION_PARAMETERS)).toEqual(['toolName', 'policy', 'autoInvoke']);
  });

  it('rejects an action it does not own', async () => {
    const { actions, ctx } = createActions();
    await expectError(actions.execute('settings.get', {}, ctx), 400, /Unsupported/);
  });
});

describe('policy decisions', () => {
  it('matches like OpenCode Wildcard.match', () => {
    expect(matchesWildcard('mcp:github-enterprise', 'mcp:github*')).toBe(true);
    expect(matchesWildcard('mcp:linear', 'mcp:github*')).toBe(false);
    expect(matchesWildcard('ab', 'a?')).toBe(true);
    expect(matchesWildcard('git', 'git *')).toBe(true);
    expect(matchesWildcard('a.b', 'a.b')).toBe(true);
    expect(matchesWildcard('axb', 'a.b')).toBe(false);
  });

  it('reverses documents so the user-global statement decides last', () => {
    const statements = readPolicyStatements([
      doc('/home/u/.config/opencode/opencode.json', [{ action: 'integration.use', resource: 'skill:deploy', effect: 'allow' }]),
      doc('/repo/opencode.json', [{ action: 'integration.use', resource: 'skill:*', effect: 'deny' }]),
      { type: 'directory', path: '/repo/.opencode' },
    ]);
    expect(isIntegrationDenied(statements, 'skill:deploy')).toBe(false);
    expect(isIntegrationDenied(statements, 'skill:other')).toBe(true);
    expect(isIntegrationDenied(statements, 'mcp:x')).toBe(false);
  });
});

describe('mcp.list', () => {
  it('merges config entries with runtime status and policy blocks', async () => {
    writeJson(userConfigPath, { mcp: { servers: {
      github: { type: 'remote', url: 'https://example.test/mcp' },
      local: { type: 'local', command: ['srv'], disabled: true },
    } } });
    const client = createClient({
      mcp: { list: vi.fn(async () => ({ data: [
        { name: 'github', status: { status: 'connected' } },
        { name: 'from-plugin', status: { status: 'failed', error: 'boom' }, integrationID: 'int_1' },
      ] })) },
      config: { get: vi.fn(async () => [doc(userConfigPath, [{ action: 'integration.use', resource: 'mcp:local', effect: 'deny' }])]) },
    });
    const { actions, ctx } = createActions({ client });
    const result = await actions.execute('mcp.list', {}, ctx);
    expect(ctx.getClient).toHaveBeenCalledWith(projectDir);
    const byName = Object.fromEntries(result.servers.map((server) => [server.name, server]));
    expect(byName.github).toMatchObject({ type: 'remote', inConfig: true, enabled: true, configScope: 'user', status: 'connected', policyDenied: false, tools: null });
    expect(byName.local).toMatchObject({ enabled: false, status: 'not-loaded', policyDenied: true });
    expect(byName['from-plugin']).toMatchObject({ inConfig: false, enabled: null, status: 'failed', error: 'boom', integrationID: 'int_1' });
    expect(result.toolsNote).toMatch(/no route that lists tools/);
    expect(result.runtimeError).toBeUndefined();
  });

  it('reports unknown status and policies when OpenCode cannot be asked, instead of an empty success', async () => {
    writeJson(userConfigPath, { mcp: { servers: { github: { type: 'remote', url: 'https://example.test/mcp' } } } });
    const { actions, ctx } = createActions({ getClient: vi.fn(async () => { throw new Error('OpenCode is not ready'); }) });
    const result = await actions.execute('mcp.list', {}, ctx);
    expect(result.runtimeError).toBe('OpenCode is not ready');
    expect(result.servers).toEqual([expect.objectContaining({ name: 'github', status: 'unknown', policyDenied: null })]);

    const client = createClient({ config: { get: vi.fn(async () => { throw new Error('no'); }) } });
    const second = createActions({ client });
    const partial = await second.actions.execute('mcp.list', {}, second.ctx);
    expect(partial.policiesUnavailable).toBe(true);
    expect(partial.servers[0].policyDenied).toBeNull();
  });
});

describe('mcp.toggle', () => {
  it('saves the disabled flag where the server lives and disconnects it', async () => {
    const projectConfig = path.join(projectDir, 'opencode.json');
    writeJson(projectConfig, { mcp: { servers: { github: { type: 'remote', url: 'https://example.test/mcp' } } } });
    const { actions, client, ctx } = createActions();
    const result = await actions.execute('mcp.toggle', { name: 'github', disabled: true }, ctx);
    expect(result).toMatchObject({ name: 'github', disabled: true, configFile: projectConfig, runtime: { action: 'disconnect', ok: true } });
    expect(readJson(projectConfig).mcp.servers.github.disabled).toBe(true);
    expect(client.mcp.disconnect).toHaveBeenCalledWith({ server: 'github' });
    expect(fs.existsSync(userConfigPath)).toBe(false);
  });

  it('adds a policy block on request and removes every exact block when enabling', async () => {
    writeJson(userConfigPath, { mcp: { servers: { github: { type: 'remote', url: 'https://example.test/mcp', disabled: true } } } });
    writeJson(path.join(projectDir, 'opencode.json'), { experimental: { policies: [{ action: 'integration.use', resource: 'mcp:github', effect: 'deny' }] } });
    const { actions, client, ctx } = createActions();

    const disabled = await actions.execute('mcp.toggle', { name: 'github', disabled: true, policy: true }, ctx);
    expect(disabled.policy).toEqual({ file: userConfigPath, changed: true });
    expect(readJson(userConfigPath).experimental.policies).toEqual([{ action: 'integration.use', resource: 'mcp:github', effect: 'deny' }]);

    const enabled = await actions.execute('mcp.toggle', { name: 'github', disabled: false, policy: true }, ctx);
    expect(enabled.policy.changed).toEqual([userConfigPath, path.join(projectDir, 'opencode.json')]);
    expect(readJson(userConfigPath).experimental).toBeUndefined();
    expect(readJson(userConfigPath).mcp.servers.github.disabled).toBe(false);
    expect(client.mcp.connect).toHaveBeenCalledWith({ server: 'github' });
    expect(enabled.stillDeniedBy).toBeUndefined();
  });

  it('reports a wildcard block that still applies after enabling', async () => {
    writeJson(userConfigPath, {
      mcp: { servers: { github: { type: 'remote', url: 'https://example.test/mcp', disabled: true } } },
      experimental: { policies: [{ action: 'integration.use', resource: 'mcp:*', effect: 'deny' }] },
    });
    const { actions, ctx } = createActions();
    const result = await actions.execute('mcp.toggle', { name: 'github', disabled: false }, ctx);
    expect(result.stillDeniedBy).toEqual([{ file: userConfigPath, statement: { action: 'integration.use', resource: 'mcp:*', effect: 'deny' } }]);
  });

  it('blocks a server that is only known at runtime by policy, and 404s it without policy', async () => {
    const { actions, ctx } = createActions();
    await expectError(actions.execute('mcp.toggle', { name: 'from-plugin', disabled: true }, ctx), 404, /policy true/);
    const result = await actions.execute('mcp.toggle', { name: 'from-plugin', disabled: true, policy: true }, ctx);
    expect(result).toMatchObject({ inConfig: false, policy: { file: userConfigPath, changed: true } });
  });

  it('keeps the saved change when the runtime call fails', async () => {
    writeJson(userConfigPath, { mcp: { servers: { github: { type: 'remote', url: 'https://example.test/mcp' } } } });
    const client = createClient({ mcp: { disconnect: vi.fn(async () => { throw new Error('McpServerNotFoundError'); }) } });
    const { actions, ctx } = createActions({ client });
    const result = await actions.execute('mcp.toggle', { name: 'github', disabled: true }, ctx);
    expect(result.runtime).toEqual({ action: 'disconnect', ok: false, error: 'McpServerNotFoundError' });
    expect(readJson(userConfigPath).mcp.servers.github.disabled).toBe(true);
  });

  it('validates its inputs and refuses an unreadable config file', async () => {
    const { actions, ctx } = createActions();
    await expectError(actions.execute('mcp.toggle', { disabled: true }, ctx), 400, /name/);
    await expectError(actions.execute('mcp.toggle', { name: 'github' }, ctx), 400, /disabled/);
    await expectError(actions.execute('mcp.toggle', { name: 'github', disabled: true, configScope: 'merged' }, ctx), 400, /configScope/);
    writeFile(userConfigPath, '{ "mcp": ');
    await expectError(actions.execute('mcp.toggle', { name: 'github', disabled: true }, ctx), 409, /by hand/);
  });
});

describe('skills.list', () => {
  it('lists OpenCode skills and disk-only skills with autoInvoke and policy state', async () => {
    const deployPath = writeSkill(projectDir, 'deploy');
    writeSkill(projectDir, 'blocked', { 'disable-model-invocation': 'true' });
    const client = createClient({
      skill: { list: vi.fn(async () => ({ data: [
        { id: 'deploy', name: 'deploy', description: 'Deploy', path: deployPath, autoinvoke: false, content: 'x' },
        { id: 'builtin-help', name: 'builtin-help', path: '/builtin/builtin-help.md', content: 'x' },
      ] })) },
      config: { get: vi.fn(async () => [doc(userConfigPath, [{ action: 'integration.use', resource: 'skill:blocked', effect: 'deny' }])]) },
    });
    const { actions, ctx } = createActions({ client });
    const result = await actions.execute('skills.list', {}, ctx);
    const byName = Object.fromEntries(result.skills.map((skill) => [skill.name, skill]));
    expect(byName.deploy).toMatchObject({ id: 'deploy', loadedByOpenCode: true, autoInvoke: false, policyDenied: false, scope: 'project' });
    expect(byName.deploy.content).toBeUndefined();
    expect(byName['builtin-help']).toMatchObject({ builtIn: true, path: '<built-in>', autoInvoke: true });
    expect(byName.blocked).toMatchObject({ id: 'blocked', loadedByOpenCode: false, autoInvoke: false, policyDenied: true });
    expect(result.openCodeSkillsUnavailable).toBeUndefined();
  });

  it('falls back to the disk scan and says so when OpenCode cannot list skills', async () => {
    writeSkill(projectDir, 'deploy');
    const client = createClient({ skill: { list: vi.fn(async () => { throw new Error('down'); }) } });
    const { actions, ctx } = createActions({ client });
    const result = await actions.execute('skills.list', {}, ctx);
    expect(result).toMatchObject({ openCodeSkillsUnavailable: true, error: 'down' });
    expect(result.skills).toEqual([expect.objectContaining({ name: 'deploy', loadedByOpenCode: null, autoInvoke: true })]);
  });
});

describe('skills.toggle', () => {
  it('edits SKILL.md for autoInvoke', async () => {
    const file = writeSkill(projectDir, 'deploy');
    const { actions, ctx } = createActions();
    const result = await actions.execute('skills.toggle', { name: 'deploy', autoInvoke: false }, ctx);
    expect(result).toMatchObject({ name: 'deploy', autoInvoke: false, skillFile: file });
    expect(fs.readFileSync(file, 'utf8')).toMatch(/disable-model-invocation: true/);
    await actions.execute('skills.toggle', { name: 'deploy', autoInvoke: true }, ctx);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/disable-model-invocation/);
  });

  it('blocks a skill by its folder id and unblocks it again', async () => {
    writeSkill(projectDir, 'deploy-folder', { name: 'deploy' });
    const { actions, ctx } = createActions();
    const disabled = await actions.execute('skills.toggle', { name: 'deploy', disabled: true }, ctx);
    expect(disabled).toMatchObject({ id: 'deploy-folder', disabled: true, policy: { file: userConfigPath, changed: true } });
    expect(readJson(userConfigPath).experimental.policies).toEqual([{ action: 'integration.use', resource: 'skill:deploy-folder', effect: 'deny' }]);

    await expect(actions.execute('skills.toggle', { name: 'deploy', disabled: true }, ctx))
      .resolves.toMatchObject({ policy: { changed: false } });

    const enabled = await actions.execute('skills.toggle', { name: 'deploy-folder', disabled: false }, ctx);
    expect(enabled).toMatchObject({ disabled: false, policy: { changed: [userConfigPath] } });
    expect(readJson(userConfigPath)).toEqual({});
  });

  it('writes a project block on request and reports a wildcard that still blocks', async () => {
    writeSkill(projectDir, 'deploy');
    writeJson(userConfigPath, { experimental: { policies: [{ action: 'integration.use', resource: 'skill:dep*', effect: 'deny' }] } });
    const { actions, ctx } = createActions();
    await actions.execute('skills.toggle', { name: 'deploy', disabled: true, configScope: 'project' }, ctx);
    expect(readJson(path.join(projectDir, '.opencode', 'opencode.json')).experimental.policies)
      .toEqual([{ action: 'integration.use', resource: 'skill:deploy', effect: 'deny' }]);
    const enabled = await actions.execute('skills.toggle', { name: 'deploy', disabled: false }, ctx);
    expect(enabled.stillDeniedBy).toEqual([expect.objectContaining({ file: userConfigPath })]);
  });

  it('unblocks by id a skill no longer found anywhere', async () => {
    writeJson(userConfigPath, { experimental: { policies: [{ action: 'integration.use', resource: 'skill:gone', effect: 'deny' }] } });
    const { actions, ctx } = createActions();
    await expect(actions.execute('skills.toggle', { name: 'gone', disabled: false }, ctx)).resolves.toMatchObject({ id: 'gone' });
    expect(readJson(userConfigPath)).toEqual({});
  });

  it('validates its inputs', async () => {
    const client = createClient({ skill: { list: vi.fn(async () => ({ data: [{ id: 'help', name: 'help', path: '/builtin/help.md' }] })) } });
    const { actions, ctx } = createActions({ client });
    await expectError(actions.execute('skills.toggle', { disabled: true }, ctx), 400, /name/);
    await expectError(actions.execute('skills.toggle', { name: 'help' }, ctx), 400, /disabled or autoInvoke/);
    await expectError(actions.execute('skills.toggle', { name: 'missing', disabled: true }, ctx), 404, /skills\.list/);
    await expectError(actions.execute('skills.toggle', { name: 'help', autoInvoke: false }, ctx), 409, /built into OpenCode/);
  });
});

describe('tools.list', () => {
  it('lists OpenChamber tools with their state and the tools config turns off', async () => {
    writeJson(userConfigPath, {
      permissions: [{ action: 'github_*', resource: '*', effect: 'deny' }, { action: 'shell', resource: 'rm *', effect: 'deny' }],
      agents: { plan: { permissions: [{ action: 'write', resource: '*', effect: 'deny' }] } },
    });
    const { actions, ctx } = createActions({ settings: { agentWebToolEnabled: false } });
    const result = await actions.execute('tools.list', {}, ctx);
    expect(result.openchamber).toEqual([
      expect.objectContaining({ tool: 'openchamber', enabled: true }),
      expect.objectContaining({ tool: 'openchamber_web', enabled: false }),
      expect.objectContaining({ tool: 'openchamber_memory', enabled: false }),
      expect.objectContaining({ tool: 'openchamber_notify', enabled: false }),
    ]);
    expect(result.opencodeBuiltin).toContain('shell');
    expect(result.disabledByConfig).toEqual([
      { tool: 'github_*', file: userConfigPath },
      { tool: 'write', file: userConfigPath, agent: 'plan' },
    ]);
  });

  it('lists the memory tool as on when its setting is on', async () => {
    const { actions, ctx } = createActions({ settings: { agentMemoryToolEnabled: true } });
    const result = await actions.execute('tools.list', {}, ctx);
    expect(result.openchamber).toContainEqual(expect.objectContaining({ tool: 'openchamber_memory', enabled: true }));
  });
});

describe('tools.toggle', () => {
  it('switches an OpenChamber tool through its setting', async () => {
    const { actions, ctx, persistSettings } = createActions();
    await expect(actions.execute('tools.toggle', { toolName: 'openchamber_notify', disabled: false }, ctx))
      .resolves.toMatchObject({ tool: 'openchamber_notify', settingKey: 'agentNotifyToolEnabled', enabled: true });
    expect(persistSettings).toHaveBeenCalledWith({ agentNotifyToolEnabled: true });
  });

  it('needs confirm to turn off the control tool', async () => {
    const { actions, ctx, persistSettings } = createActions();
    await expectError(actions.execute('tools.toggle', { toolName: 'openchamber', disabled: true }, ctx), 400, /confirm/);
    expect(persistSettings).not.toHaveBeenCalled();
    await actions.execute('tools.toggle', { toolName: 'openchamber', disabled: true, confirm: true }, ctx);
    expect(persistSettings).toHaveBeenCalledWith({ agentControlToolEnabled: false });
  });

  it('turns an OpenCode tool off with a permission rule and back on', async () => {
    writeJson(userConfigPath, { permissions: [{ action: 'read', resource: '*', effect: 'allow' }] });
    const { actions, ctx } = createActions();
    const disabled = await actions.execute('tools.toggle', { toolName: 'github_create_issue', disabled: true }, ctx);
    expect(disabled).toMatchObject({ disabled: true, file: userConfigPath, changed: true });
    expect(readJson(userConfigPath).permissions).toEqual([
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'github_create_issue', resource: '*', effect: 'deny' },
    ]);
    const enabled = await actions.execute('tools.toggle', { toolName: 'github_create_issue', disabled: false }, ctx);
    expect(enabled).toMatchObject({ disabled: false, changed: [userConfigPath] });
    expect(readJson(userConfigPath).permissions).toEqual([{ action: 'read', resource: '*', effect: 'allow' }]);
  });

  it('writes the project file on request and reports rules that still turn the tool off', async () => {
    writeJson(userConfigPath, { agents: { build: { permissions: [{ action: 'web*', resource: '*', effect: 'deny' }] } } });
    const { actions, ctx } = createActions();
    await actions.execute('tools.toggle', { toolName: 'webfetch', disabled: true, configScope: 'project' }, ctx);
    expect(readJson(path.join(projectDir, '.opencode', 'opencode.json')).permissions)
      .toEqual([{ action: 'webfetch', resource: '*', effect: 'deny' }]);
    const enabled = await actions.execute('tools.toggle', { toolName: 'webfetch', disabled: false }, ctx);
    expect(enabled.changed).toEqual([path.join(projectDir, '.opencode', 'opencode.json')]);
    expect(enabled.stillDeniedBy).toEqual([expect.objectContaining({ agent: 'build', file: userConfigPath })]);
  });

  it('refuses a pattern that would take this tool away unless confirmed, and malformed names', async () => {
    const { actions, ctx } = createActions();
    await expectError(actions.execute('tools.toggle', { toolName: '*', disabled: true }, ctx), 400, /confirm/);
    await expectError(actions.execute('tools.toggle', { toolName: 'open*', disabled: true }, ctx), 400, /confirm/);
    await expectError(actions.execute('tools.toggle', { toolName: 'bad name', disabled: true }, ctx), 400, /toolName may hold/);
    await expectError(actions.execute('tools.toggle', { toolName: 'shell' }, ctx), 400, /disabled/);
    await expectError(actions.execute('tools.toggle', { disabled: true }, ctx), 400, /toolName/);
    expect(fs.existsSync(userConfigPath)).toBe(false);
  });
});
