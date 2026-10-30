import { afterEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRuntimeMatches, pluginFileRuntimeTarget, resolveLoadState } from '../../ui/src/components/sections/plugins/pluginLoadState.ts';

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
  },
}));

// Point the user-level OpenCode config at a scratch directory BEFORE importing:
// the bridge writes agents, commands and plugins there, and a built-in agent
// such as `build` is materialised as a user-level file. Nothing here may touch
// the real ~/.config/opencode.
const scratchConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-bridge-config-'));
process.env.XDG_CONFIG_HOME = path.join(scratchConfigRoot, 'xdg');
process.env.OPENCODE_CONFIG_DIR = '';

const { handleConfigBridgeMessage } = await import('./bridge-config-runtime.ts');

const tempRoots = [];
const originalOpencodeConfig = process.env.OPENCODE_CONFIG;

const createCtx = (workingDirectory, restartImpl = async () => undefined) => {
  const restart = mock(restartImpl);
  return {
    restart,
    manager: {
      getWorkingDirectory: () => workingDirectory,
      restart,
    },
  };
};

const deps = {
  readSettings: () => ({}),
  persistSettings: async (changes) => changes,
  handleMagicPromptRequest: async () => ({ status: 200, body: { version: 1, overrides: {} } }),
  fetchOpenCodeSkillsFromApi: async () => null,
  clientReloadDelayMs: 800,
};

afterEach(() => {
  if (originalOpencodeConfig === undefined) {
    delete process.env.OPENCODE_CONFIG;
  } else {
    process.env.OPENCODE_CONFIG = originalOpencodeConfig;
  }

  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

describe('VS Code config bridge plugin parity', () => {
  test('lists a config once and exposes paths for existing file discovery', async () => {
    const root = path.join(scratchConfigRoot, 'xdg', 'opencode');
    fs.mkdirSync(root, { recursive: true });
    tempRoots.push(root);
    process.env.OPENCODE_CONFIG = path.join(root, 'opencode.jsonc');
    fs.writeFileSync(process.env.OPENCODE_CONFIG, JSON.stringify({ plugins: [{ package: './plugins/memory.ts', options: { enabled: true } }] }));
    fs.mkdirSync(path.join(root, 'plugins'));
    fs.writeFileSync(path.join(root, 'plugins', 'memory.ts'), 'export default {}');
    const listed = await handleConfigBridgeMessage({ id: 'list', type: 'api:config/plugins', payload: { target: 'list', directory: root } }, createCtx(root), deps);
    expect(listed.success).toBe(true);
    expect(listed.data.entries).toHaveLength(1);
    expect(listed.data.entries[0]).toMatchObject({ scope: 'user', options: { enabled: true } });
    expect(listed.data.files).toHaveLength(1);
    expect(listed.data.files[0]).toMatchObject({ kind: 'file', absolutePath: path.join(root, 'plugins', 'memory.ts'), resolvedPath: listed.data.entries[0].resolvedPath });
  });

  test('preserves runtime status through a symlinked config directory', async () => {
    const physicalDir = fs.mkdtempSync(path.join(scratchConfigRoot, 'physical-'));
    const globalDir = path.join(process.env.XDG_CONFIG_HOME, 'opencode');
    tempRoots.push(globalDir, physicalDir);
    fs.mkdirSync(path.dirname(globalDir), { recursive: true });
    fs.mkdirSync(path.join(physicalDir, 'plugins'));
    fs.symlinkSync(physicalDir, globalDir, 'dir');
    const originalPath = path.join(globalDir, 'plugins', 'memory.ts');
    fs.writeFileSync(originalPath, 'export default {}');
    const listed = await handleConfigBridgeMessage({ id: 'list-link', type: 'api:config/plugins', payload: { target: 'list', directory: physicalDir } }, createCtx(physicalDir), deps);
    expect(listed.success).toBe(true);
    const file = listed.data.files.find((file) => file.scope === 'user');
    expect(file).toMatchObject({ absolutePath: originalPath, resolvedPath: fs.realpathSync(originalPath) });
    const target = pluginFileRuntimeTarget(file.absolutePath);
    for (const state of [{ kind: 'active' }, { kind: 'failed', error: 'load failed', ref: 'err_local' }]) {
      const result = resolveLoadState(findRuntimeMatches(target, [{ source: { kind: 'local', path: originalPath }, state }]));
      expect(result).toEqual(state.kind === 'active' ? { kind: 'active', version: null } : state);
    }
  });

  test('keeps custom relative targets when the global config is a symlink alias', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-alias-'));
    const globalDir = path.join(process.env.XDG_CONFIG_HOME, 'opencode');
    tempRoots.push(root, globalDir);
    const configPath = path.join(root, 'opencode.json');
    const spec = './plugins/memory';
    fs.writeFileSync(configPath, JSON.stringify({ plugins: [{ package: spec, options: { owner: 'custom' } }] }));
    const customPluginPath = path.join(root, 'plugins', 'memory');
    fs.mkdirSync(customPluginPath, { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'plugins', 'memory'), { recursive: true });
    fs.symlinkSync(configPath, path.join(globalDir, 'opencode.json'));
    process.env.OPENCODE_CONFIG = configPath;

    const listed = await handleConfigBridgeMessage({
      id: 'list-alias', type: 'api:config/plugins', payload: { target: 'list', directory: globalDir },
    }, createCtx(globalDir), deps);
    expect(listed.success).toBe(true);
    expect(listed.data.entries).toEqual([
      expect.objectContaining({
        id: Buffer.from(`config:user:${spec}`).toString('base64url'),
        spec, scope: 'user', resolvedPath: fs.realpathSync(customPluginPath), options: { owner: 'custom' },
      }),
    ]);
  });

  test('explicit config reload restarts OpenCode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-reload-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const reloaded = await handleConfigBridgeMessage({
      id: 'reload',
      type: 'api:config/reload',
    }, ctx, deps);

    expect(reloaded).toEqual({
      id: 'reload',
      type: 'api:config/reload',
      success: true,
      data: { restarted: true },
    });
    expect(ctx.restart).toHaveBeenCalledTimes(1);
  });

  test('removes agent fields when update payload sends null', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-agent-null-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const configDir = path.join(root, '.opencode');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agent: {
        build: {
          variant: 'fast',
          temperature: 0.3,
          top_p: 0.8,
          mode: 'subagent',
        },
      },
    }, null, 2), 'utf8');

    const updated = await handleConfigBridgeMessage({
      id: 'update-agent-null-fields',
      type: 'api:config/agents',
      payload: {
        method: 'PATCH',
        name: 'build',
        directory: root,
        body: { variant: null, temperature: null, top_p: null },
      },
    }, ctx, deps);

    expect(updated?.success).toBe(true);
    // The v1 `agent` entry is rewritten in place as a v2 `agents` entry, and the
    // cleared v1 fields are removed from where v2 keeps them: `variant` off the
    // model reference, `temperature`/`top_p` out of `request.body`.
    const agentConfig = readJson(configPath);
    expect(agentConfig.agent).toBeUndefined();
    expect(agentConfig.agents.build).toEqual({ mode: 'subagent' });
  });

  test('creates, lists, updates, and deletes project plugin entries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugins-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'entry',
        directory: root,
        body: { scope: 'project', spec: 'plugin-a', options: { enabled: true } },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(created?.data).toMatchObject({
      success: true,
      message: 'Plugin entry changed.',
    });
    expect(ctx.restart).not.toHaveBeenCalled();

    const listed = await handleConfigBridgeMessage({
      id: 'list',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const entries = listed?.data?.entries || [];
    const entry = entries.find((candidate) => candidate.spec === 'plugin-a');
    expect(entry?.scope).toBe('project');

    const updated = await handleConfigBridgeMessage({
      id: 'update',
      type: 'api:config/plugins',
      payload: {
        method: 'PATCH',
        target: 'entry',
        directory: root,
        pluginId: entry?.id,
        body: { spec: 'plugin-b' },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);

    const config = JSON.parse(fs.readFileSync(path.join(root, '.opencode', 'opencode.json'), 'utf8'));
    expect(config.plugin).toBeUndefined();
    expect(config.plugins).toEqual([{ package: 'plugin-b', options: { enabled: true } }]);

    const relisted = await handleConfigBridgeMessage({
      id: 'relist',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const updatedEntry = (relisted?.data?.entries || []).find((candidate) => candidate.spec === 'plugin-b');

    const deleted = await handleConfigBridgeMessage({
      id: 'delete',
      type: 'api:config/plugins',
      payload: { method: 'DELETE', target: 'entry', directory: root, pluginId: updatedEntry?.id },
    }, ctx, deps);
    expect(deleted?.success).toBe(true);
  });

  test('creates and reads project plugin files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-files-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'project', fileName: 'demo-plugin.ts', content: 'export default {}' },
      },
    }, ctx, deps);
    expect(created?.success).toBe(true);

    const listed = await handleConfigBridgeMessage({
      id: 'list',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const files = listed?.data?.files || [];
    const file = files.find((candidate) => candidate.fileName === 'demo-plugin.ts');
    expect(file?.scope).toBe('project');

    const read = await handleConfigBridgeMessage({
      id: 'read-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'file', directory: root, pluginId: file?.id },
    }, ctx, deps);
    expect(read?.data).toEqual({ fileName: 'demo-plugin.ts', scope: 'project', content: 'export default {}' });
  });

  test('updates and deletes user plugin entries from OPENCODE_CONFIG source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-custom-config-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'custom-config');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugin: ['custom-plugin'] }, null, 2), 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
    const ctx = createCtx(root);

    const listed = await handleConfigBridgeMessage({
      id: 'list-custom',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const entry = (listed?.data?.entries || []).find((candidate) => candidate.spec === 'custom-plugin');
    expect(entry?.scope).toBe('user');

    const updated = await handleConfigBridgeMessage({
      id: 'update-custom',
      type: 'api:config/plugins',
      payload: {
        method: 'PATCH',
        target: 'entry',
        directory: root,
        pluginId: entry?.id,
        body: { spec: 'custom-plugin-next' },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);
    // Touching one entry migrates the whole v1 `plugin` array into v2 `plugins`.
    expect(readJson(configPath).plugin).toBeUndefined();
    expect(readJson(configPath).plugins).toEqual(['custom-plugin-next']);

    const relisted = await handleConfigBridgeMessage({
      id: 'relist-custom',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const updatedEntry = (relisted?.data?.entries || []).find((candidate) => candidate.spec === 'custom-plugin-next');

    const deleted = await handleConfigBridgeMessage({
      id: 'delete-custom',
      type: 'api:config/plugins',
      payload: { method: 'DELETE', target: 'entry', directory: root, pluginId: updatedEntry?.id },
    }, ctx, deps);
    expect(deleted?.success).toBe(true);
    expect(readJson(configPath).plugin).toBeUndefined();
    expect(readJson(configPath).plugins).toBeUndefined();
  });

  test('lists the global config and plugins folder when OPENCODE_CONFIG names a missing file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-missing-custom-'));
    tempRoots.push(root);
    const globalDir = path.join(process.env.XDG_CONFIG_HOME, 'opencode');
    const globalConfigPath = path.join(globalDir, 'opencode.json');
    const globalFilePath = path.join(globalDir, 'plugins', 'global-file.js');
    fs.mkdirSync(path.dirname(globalFilePath), { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify({ plugins: ['global-plugin'] }), 'utf8');
    fs.writeFileSync(globalFilePath, '', 'utf8');
    process.env.OPENCODE_CONFIG = path.join(root, 'missing', 'opencode.json');

    try {
      const listed = await handleConfigBridgeMessage({
        id: 'list-missing-custom',
        type: 'api:config/plugins',
        payload: { method: 'GET', target: 'list', directory: root },
      }, createCtx(root), deps);

      expect((listed?.data?.entries || []).map((entry) => [entry.spec, entry.scope])).toEqual([['global-plugin', 'user']]);
      expect((listed?.data?.files || []).map((file) => [file.fileName, file.scope])).toEqual([['global-file.js', 'user']]);
    } finally {
      fs.rmSync(globalConfigPath, { force: true });
      fs.rmSync(globalFilePath, { force: true });
    }
  });

  test('writes user plugin files to the global plugins folder when OPENCODE_CONFIG is set', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-custom-files-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'custom-config');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '{}', 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create-custom-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'user', fileName: 'demo-plugin.ts', content: 'export default {}' },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    // OpenCode scans only the global `plugins/` folder for user plugin files.
    const globalFilePath = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'plugins', 'demo-plugin.ts');
    expect(fs.readFileSync(globalFilePath, 'utf8')).toBe('export default {}');
    expect(fs.existsSync(path.join(configDir, 'plugins'))).toBe(false);
    fs.rmSync(globalFilePath, { force: true });
  });

  // OpenCode 2 watches its config sources, so a write is live as soon as it
  // lands: there is no restart to defer and no restart that can fail. The
  // mutation just reports where it wrote.
  test('creates an MCP server under mcp.servers without restarting OpenCode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-mcp-create-'));
    tempRoots.push(root);
    const ctx = createCtx(root, async () => {
      throw new Error('restart failed');
    });
    const configPath = path.join(root, '.opencode', 'opencode.json');

    const created = await handleConfigBridgeMessage({
      id: 'create-mcp',
      type: 'api:config/mcp',
      payload: {
        method: 'POST',
        name: 'mcp-server',
        directory: root,
        body: { scope: 'project', type: 'local', command: ['node', 'server.js'], enabled: false },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(created?.data).toMatchObject({
      success: true,
      message: 'MCP server "mcp-server" created.',
      path: configPath,
    });
    expect(ctx.restart).not.toHaveBeenCalled();

    const written = readJson(configPath);
    expect(written.mcp['mcp-server']).toBeUndefined();
    expect(written.mcp.servers['mcp-server']).toEqual({
      type: 'local',
      command: ['node', 'server.js'],
      // v1 `enabled: false` becomes the inverse v2 `disabled: true`.
      disabled: true,
    });
  });
});

describe('skills catalog bridge', () => {
  const savedEnv = {};
  const setEnv = (key, value) => {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete savedEnv[key];
    }
  });

  // A local bare repository stands in for github.com/acme/skills, and a `git`
  // wrapper first on PATH records every Git command the scan runs.
  const createCatalogFixture = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skills-catalog-'));
    tempRoots.push(root);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const runGit = (cwd, ...args) => execFileSync(realGit, ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', ...args], { cwd, stdio: 'pipe' });
    const work = path.join(root, 'work');
    for (const skillDir of ['skills/alpha', 'skills/beta', 'plugins/bundle/skills/gamma']) {
      fs.mkdirSync(path.join(work, skillDir), { recursive: true });
      fs.writeFileSync(path.join(work, skillDir, 'SKILL.md'), `---\nname: ${path.basename(skillDir)}\n---\nBody\n`);
    }
    runGit(work, 'init', '-q');
    runGit(work, 'add', '.');
    runGit(work, 'commit', '-qm', 'skills');
    const bare = path.join(root, 'remote', 'acme', 'skills.git');
    runGit(root, 'clone', '-q', '--bare', work, bare);
    runGit(bare, 'config', 'uploadpack.allowFilter', 'true');

    const binDir = path.join(root, 'bin');
    const log = path.join(root, 'git.log');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    setEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH}`);
    setEnv('GIT_CONFIG_COUNT', '1');
    setEnv('GIT_CONFIG_KEY_0', `url.${new URL(`file://${path.join(root, 'remote')}/`).href}.insteadOf`);
    setEnv('GIT_CONFIG_VALUE_0', 'https://github.com/');
    setEnv('OPENCHAMBER_DATA_DIR', path.join(root, 'data'));

    const gitCommands = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
    return { root, gitCommands };
  };

  const catalogDeps = {
    ...deps,
    readSettings: () => ({ skillCatalogs: [{ id: 'acme', label: 'Acme', source: 'acme/skills', subpath: 'skills' }] }),
  };

  test.skipIf(process.platform === 'win32')('lists the sources without scanning any of them', async () => {
    const { root, gitCommands } = createCatalogFixture();

    const response = await handleConfigBridgeMessage({ id: 'c1', type: 'api:config/skills:catalog' }, createCtx(root), catalogDeps);

    expect(response?.success).toBe(true);
    expect(response?.data.ok).toBe(true);
    expect(response?.data.sources.map((source) => source.id)).toContain('acme');
    expect(response?.data.itemsBySource).toEqual({});
    expect(gitCommands()).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')('scans one source once for requests that arrive together', async () => {
    const { root, gitCommands } = createCatalogFixture();
    const request = (id, refresh) => handleConfigBridgeMessage({
      id,
      type: 'api:config/skills:catalog/source',
      payload: { sourceId: 'acme', refresh },
    }, createCtx(root), catalogDeps);

    const responses = await Promise.all([request('s1', false), request('s2', true), request('s3', true)]);

    for (const response of responses) {
      expect(response?.data.ok).toBe(true);
      expect(response?.data.items.map((item) => item.skillDir)).toEqual(['skills/alpha', 'skills/beta']);
    }
    const commands = gitCommands();
    expect(commands.filter((line) => line.startsWith('clone '))).toHaveLength(1);
    expect(commands.filter((line) => line.includes(' show '))).toEqual([]);
  });

  test('answers an unknown source with an error', async () => {
    const response = await handleConfigBridgeMessage({
      id: 's4',
      type: 'api:config/skills:catalog/source',
      payload: { sourceId: 'missing' },
    }, createCtx(os.tmpdir()), deps);

    expect(response?.data).toEqual({ ok: false, error: { kind: 'invalidSource', message: 'Unknown source' } });
  });
});

describe('magic prompt bridge', () => {
  test('hands the parsed request to the host and returns its status and body', async () => {
    const handleMagicPromptRequest = mock(async () => ({ status: 409, body: { error: 'bad file', code: 'project_config_invalid' } }));
    const send = (body) => handleConfigBridgeMessage({
      id: 'm1',
      type: 'api:magic-prompts',
      payload: { method: 'PUT', id: 'plan.todo.instructions', query: { projectId: ['path_abc'], scope: ['project'], sessionDirectory: [] }, body },
    }, undefined, { ...deps, handleMagicPromptRequest });

    const response = await send({ text: '' });
    // A selector in the body is reported, so the host refuses it instead of writing the global file.
    await send({ text: 'x', scope: 'project' });

    expect(handleMagicPromptRequest.mock.calls.map(([request]) => request)).toEqual([
      { method: 'PUT', id: 'plan.todo.instructions', projectId: ['path_abc'], scope: ['project'], sessionDirectory: [], text: '', bodyNamesSelector: false },
      { method: 'PUT', id: 'plan.todo.instructions', projectId: ['path_abc'], scope: ['project'], sessionDirectory: [], text: 'x', bodyNamesSelector: true },
    ]);
    expect(response).toEqual({ id: 'm1', type: 'api:magic-prompts', success: true, data: { status: 409, body: { error: 'bad file', code: 'project_config_invalid' } } });
  });
});
