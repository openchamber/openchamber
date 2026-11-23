import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
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
const { MAX_PLUGIN_FILE_BYTES } = await import('./opencodeConfig.ts');
const { SKILL_SUPPORTING_FILE_MAX_BYTES } = await import('./opencodeConfig.ts');

const tempRoots = [];
const originalOpencodeConfig = process.env.OPENCODE_CONFIG;

const createCtx = (workingDirectory, restartImpl = async () => undefined) => {
  const restart = mock(restartImpl);
  return {
    restart,
    context: {
      globalStorageUri: { fsPath: path.join(scratchConfigRoot, 'storage') },
    },
    manager: {
      getWorkingDirectory: () => workingDirectory,
      restart,
      getDebugInfo: () => ({ mode: 'managed', status: 'connected', workingDirectory }),
      refreshPluginSwitches: async () => ({ updated: true, requiresManualRestart: false }),
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

  test('refuses over-cap plugin file writes and leaves any existing file unchanged (#1444)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-write-cap-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const overCap = 'x'.repeat(MAX_PLUGIN_FILE_BYTES + 1);

    const created = await handleConfigBridgeMessage({
      id: 'create-over-cap-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'project', fileName: 'over-cap.ts', content: overCap },
      },
    }, ctx, deps);
    expect(created?.success).toBe(false);
    expect(created?.code).toBe('PLUGIN_FILE_TOO_LARGE');
    expect(fs.existsSync(path.join(root, '.opencode', 'plugins', 'over-cap.ts'))).toBe(false);

    const small = await handleConfigBridgeMessage({
      id: 'create-small-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'project', fileName: 'small.ts', content: 'original' },
      },
    }, ctx, deps);
    expect(small?.success).toBe(true);

    const listed = await handleConfigBridgeMessage({
      id: 'list-write-cap',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const file = listed?.data?.files?.find((candidate) => candidate.fileName === 'small.ts');

    const updated = await handleConfigBridgeMessage({
      id: 'update-over-cap-file',
      type: 'api:config/plugins',
      payload: {
        method: 'PUT',
        target: 'file',
        directory: root,
        pluginId: file?.id,
        body: { content: overCap },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(false);
    expect(updated?.code).toBe('PLUGIN_FILE_TOO_LARGE');
    expect(fs.readFileSync(path.join(root, '.opencode', 'plugins', 'small.ts'), 'utf8')).toBe('original');

    const atCap = 'x'.repeat(MAX_PLUGIN_FILE_BYTES);
    const updatedAtCap = await handleConfigBridgeMessage({
      id: 'update-at-cap-file',
      type: 'api:config/plugins',
      payload: {
        method: 'PUT',
        target: 'file',
        directory: root,
        pluginId: file?.id,
        body: { content: atCap },
      },
    }, ctx, deps);
    expect(updatedAtCap?.success).toBe(true);
    const read = await handleConfigBridgeMessage({
      id: 'read-at-cap-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'file', directory: root, pluginId: file?.id },
    }, ctx, deps);
    expect(read?.data?.content).toBe(atCap);
  });

  test('refuses over-limit plugin files on GET and PUT without reading or overwriting them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-file-limit-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const fileName = 'large-plugin.ts';
    const pluginPath = path.join(root, '.opencode', 'plugins', fileName);
    const content = 'x'.repeat(MAX_PLUGIN_FILE_BYTES + 1);

    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, content, 'utf8');
    const listed = await handleConfigBridgeMessage({
      id: 'list-large-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const file = listed?.data?.files?.find((candidate) => candidate.fileName === fileName);
    const readPaths = [];
    const originalReadFileSync = fs.readFileSync;
    let read;
    let updated;

    fs.readFileSync = (...args) => {
      readPaths.push(args[0]);
      return originalReadFileSync.apply(fs, args);
    };

    try {
      read = await handleConfigBridgeMessage({
        id: 'read-large-file',
        type: 'api:config/plugins',
        payload: { method: 'GET', target: 'file', directory: root, pluginId: file?.id },
      }, ctx, deps);
      updated = await handleConfigBridgeMessage({
        id: 'update-large-file',
        type: 'api:config/plugins',
        payload: {
          method: 'PUT',
          target: 'file',
          directory: root,
          pluginId: file?.id,
          body: { content: 'replacement' },
        },
      }, ctx, deps);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    const error = {
      success: false,
      error: `Plugin file exceeds maximum size of ${MAX_PLUGIN_FILE_BYTES} bytes`,
      code: 'PLUGIN_FILE_TOO_LARGE',
    };
    expect(read).toMatchObject({ id: 'read-large-file', type: 'api:config/plugins', ...error });
    expect(updated).toMatchObject({ id: 'update-large-file', type: 'api:config/plugins', ...error });
    expect(readPaths).not.toContain(pluginPath);
    expect(fs.readFileSync(pluginPath, 'utf8')).toBe(content);
  });

  test('refuses a plugin file that grows past the cap after the handle stat without buffering it whole (#1410)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-file-grown-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const fileName = 'grown-plugin.ts';
    const pluginPath = path.join(root, '.opencode', 'plugins', fileName);
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, 'x'.repeat(MAX_PLUGIN_FILE_BYTES + 1024), 'utf8');

    const listed = await handleConfigBridgeMessage({
      id: 'list-grown-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const file = listed?.data?.files?.find((candidate) => candidate.fileName === fileName);

    // The descriptor growth case: the handle stat answers the pre-growth
    // size while the read meets the grown file.
    const originalFstatSync = fs.fstatSync;
    const originalReadSync = fs.readSync;
    let requested = 0;
    fs.fstatSync = (fd) => {
      const stats = originalFstatSync(fd);
      Object.defineProperty(stats, 'size', { value: 16 });
      return stats;
    };
    fs.readSync = (fd, buffer, offset, length, position) => {
      requested += length;
      return originalReadSync(fd, buffer, offset, length, position);
    };

    let read;
    try {
      read = await handleConfigBridgeMessage({
        id: 'read-grown-file',
        type: 'api:config/plugins',
        payload: { method: 'GET', target: 'file', directory: root, pluginId: file?.id },
      }, ctx, deps);
    } finally {
      fs.fstatSync = originalFstatSync;
      fs.readSync = originalReadSync;
    }

    expect(read).toMatchObject({
      id: 'read-grown-file',
      type: 'api:config/plugins',
      success: false,
      error: `Plugin file exceeds maximum size of ${MAX_PLUGIN_FILE_BYTES} bytes`,
      code: 'PLUGIN_FILE_TOO_LARGE',
    });
    expect(requested).toBeGreaterThan(0);
    expect(requested).toBeLessThanOrEqual(MAX_PLUGIN_FILE_BYTES + 1);
  });

  test('reads and updates plugin files exactly at the size limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-file-at-limit-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const fileName = 'at-limit-plugin.ts';
    const content = 'x'.repeat(MAX_PLUGIN_FILE_BYTES);

    const created = await handleConfigBridgeMessage({
      id: 'create-at-limit-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'project', fileName, content },
      },
    }, ctx, deps);
    expect(created?.success).toBe(true);

    const listed = await handleConfigBridgeMessage({
      id: 'list-at-limit-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const file = listed?.data?.files?.find((candidate) => candidate.fileName === fileName);
    const pluginPath = path.join(root, '.opencode', 'plugins', fileName);

    const read = await handleConfigBridgeMessage({
      id: 'read-at-limit-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'file', directory: root, pluginId: file?.id },
    }, ctx, deps);
    expect(fs.statSync(pluginPath).size).toBe(MAX_PLUGIN_FILE_BYTES);
    expect(read?.data).toEqual({ fileName, scope: 'project', content });

    const updated = await handleConfigBridgeMessage({
      id: 'update-at-limit-file',
      type: 'api:config/plugins',
      payload: {
        method: 'PUT',
        target: 'file',
        directory: root,
        pluginId: file?.id,
        body: { content },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);
    expect(fs.readFileSync(pluginPath, 'utf8')).toBe(content);
  });

  test('keeps missing plugin files on the existing not-found path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-file-missing-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const fileName = 'missing-plugin.ts';

    await handleConfigBridgeMessage({
      id: 'create-missing-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'project', fileName, content: 'export default {}' },
      },
    }, ctx, deps);
    const listed = await handleConfigBridgeMessage({
      id: 'list-missing-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const file = listed?.data?.files?.find((candidate) => candidate.fileName === fileName);
    fs.unlinkSync(path.join(root, '.opencode', 'plugins', fileName));

    for (const method of ['GET', 'PUT']) {
      const response = await handleConfigBridgeMessage({
        id: `missing-${method.toLowerCase()}-file`,
        type: 'api:config/plugins',
        payload: {
          method,
          target: 'file',
          directory: root,
          pluginId: file?.id,
          body: { content: 'replacement' },
        },
      }, ctx, deps);
      expect(response).toMatchObject({
        success: false,
        error: 'Plugin file not found',
      });
    }
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

describe('VS Code config bridge behavior AGENTS.md size gate', () => {
  const agentsMdPath = path.join(scratchConfigRoot, 'xdg', 'opencode', 'AGENTS.md');
  const CAP = 1024 * 1024;

  const writeAgentsMd = (size) => {
    fs.mkdirSync(path.dirname(agentsMdPath), { recursive: true });
    fs.writeFileSync(agentsMdPath, 'x'.repeat(size), 'utf8');
  };

  afterEach(() => {
    fs.rmSync(agentsMdPath, { force: true });
  });

  test('get refuses an over-cap AGENTS.md without returning its content', async () => {
    writeAgentsMd(CAP + 1);
    const ctx = createCtx(scratchConfigRoot);
    const result = await handleConfigBridgeMessage({ id: 'get-big', type: 'api:behavior/agents-md:get' }, ctx, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain(`maximum size of ${CAP} bytes`);
    expect(result.data).toBeUndefined();
  });

  test('get returns an at-cap AGENTS.md byte-identically', async () => {
    writeAgentsMd(CAP);
    const ctx = createCtx(scratchConfigRoot);
    const result = await handleConfigBridgeMessage({ id: 'get-cap', type: 'api:behavior/agents-md:get' }, ctx, deps);
    expect(result.success).toBe(true);
    expect(result.data.exists).toBe(true);
    expect(result.data.content).toBe('x'.repeat(CAP));
  });

  test('get refuses an AGENTS.md that grows past the cap after the handle stat (#1410)', async () => {
    writeAgentsMd(CAP + 1024);
    const ctx = createCtx(scratchConfigRoot);

    // The descriptor growth case: the handle stat answers the pre-growth
    // size while the read meets the grown file.
    const originalOpen = fs.promises.open;
    let requested = 0;
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      const originalStat = handle.stat.bind(handle);
      handle.stat = async () => {
        const stats = await originalStat();
        Object.defineProperty(stats, 'size', { value: 16 });
        return stats;
      };
      const originalRead = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        requested += length;
        return originalRead(buffer, offset, length, position);
      };
      return handle;
    };

    let result;
    try {
      result = await handleConfigBridgeMessage({ id: 'get-grown', type: 'api:behavior/agents-md:get' }, ctx, deps);
    } finally {
      fs.promises.open = originalOpen;
    }
    expect(result.success).toBe(false);
    expect(result.error).toContain(`maximum size of ${CAP} bytes`);
    expect(result.data).toBeUndefined();
    expect(requested).toBeGreaterThan(0);
    expect(requested).toBeLessThanOrEqual(CAP + 1);
  });

  test('save refuses multibyte content whose UTF-8 bytes exceed the cap', async () => {
    const ctx = createCtx(scratchConfigRoot);
    // 400,000 UTF-16 code units but 1,200,000 UTF-8 bytes: a length-based
    // check would accept this and every later get would refuse it.
    const content = '界'.repeat(400_000);
    expect(content.length).toBeLessThan(CAP);
    const result = await handleConfigBridgeMessage(
      { id: 'save-multibyte-big', type: 'api:behavior/agents-md:save', payload: { content } },
      ctx,
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(`maximum size of ${CAP} bytes`);
    expect(fs.existsSync(agentsMdPath)).toBe(false);
  });

  test('save and get round-trip multibyte content under the byte cap', async () => {
    const ctx = createCtx(scratchConfigRoot);
    const content = '界'.repeat(300_000); // 900,000 UTF-8 bytes
    const saved = await handleConfigBridgeMessage(
      { id: 'save-multibyte-ok', type: 'api:behavior/agents-md:save', payload: { content } },
      ctx,
      deps,
    );
    expect(saved.success).toBe(true);

    const loaded = await handleConfigBridgeMessage({ id: 'get-multibyte-ok', type: 'api:behavior/agents-md:get' }, ctx, deps);
    expect(loaded.success).toBe(true);
    expect(loaded.data.content).toBe(content);
  });

  test('get reports a missing AGENTS.md as not existing', async () => {
    fs.rmSync(agentsMdPath, { force: true });
    const ctx = createCtx(scratchConfigRoot);
    const result = await handleConfigBridgeMessage({ id: 'get-missing', type: 'api:behavior/agents-md:get' }, ctx, deps);
    expect(result).toEqual({
      id: 'get-missing',
      type: 'api:behavior/agents-md:get',
      success: true,
      data: { content: '', exists: false, path: agentsMdPath },
    });
  });

  test('save preserves the previous AGENTS.md when replacement fails', async () => {
    fs.mkdirSync(path.dirname(agentsMdPath), { recursive: true });
    fs.writeFileSync(agentsMdPath, 'Old content', 'utf8');
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });
    try {
      const ctx = createCtx(scratchConfigRoot);
      await expect(
        handleConfigBridgeMessage(
          { id: 'save-rename-fails', type: 'api:behavior/agents-md:save', payload: { content: 'New content' } },
          ctx,
          deps,
        ),
      ).rejects.toThrow('rename failed');
      expect(fs.readFileSync(agentsMdPath, 'utf8')).toBe('Old content');
      const leftovers = fs.readdirSync(path.dirname(agentsMdPath)).filter((name) => name.startsWith('AGENTS.md.tmp-'));
      expect(leftovers).toEqual([]);
    } finally {
      renameSpy.mockRestore();
    }
  });
});
describe('VS Code config bridge skill supporting-file size gate (#1158)', () => {
  const SKILL_FILE_CAP = SKILL_SUPPORTING_FILE_MAX_BYTES;

  const createProjectSkill = (files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-cap-'));
    tempRoots.push(root);
    const skillDir = path.join(root, '.opencode', 'skills', 'cap-test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: cap-test-skill\ndescription: Size gate test skill\n---\n\nBody.\n',
      'utf8',
    );
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(skillDir, name), content, 'utf8');
    }
    return root;
  };

  const getSupportingFile = (root, filePath) => handleConfigBridgeMessage({
    id: 'skill-file-get',
    type: 'api:config/skills/files',
    payload: { method: 'GET', name: 'cap-test-skill', filePath },
  }, createCtx(root), deps);

  test('refuses an over-cap supporting file with a clear too-large error', async () => {
    const root = createProjectSkill({ 'big.txt': 'a'.repeat(SKILL_FILE_CAP + 1) });

    const response = await getSupportingFile(root, 'big.txt');

    expect(response?.success).toBe(false);
    expect(response?.error).toContain('too large');
    expect(response?.error).toContain(String(SKILL_FILE_CAP));
  });

  test('returns an at-cap supporting file byte-identically', async () => {
    const content = 'a'.repeat(SKILL_FILE_CAP);
    const root = createProjectSkill({ 'at-cap.txt': content });

    const response = await getSupportingFile(root, 'at-cap.txt');

    expect(response?.success).toBe(true);
    expect(response?.data).toEqual({ content });
  });

  test('keeps the not-found shape for a missing supporting file', async () => {
    const root = createProjectSkill({ 'small.txt': 'hello' });

    const missing = await getSupportingFile(root, 'nope.txt');
    expect(missing?.success).toBe(false);
    expect(missing?.error).toContain('not found');

    const small = await getSupportingFile(root, 'small.txt');
    expect(small?.success).toBe(true);
    expect(small?.data).toEqual({ content: 'hello' });
  });

  test('refuses an over-cap supporting-file PUT and leaves the file unchanged (#1444)', async () => {
    const root = createProjectSkill({ 'doc.txt': 'original' });

    const mutateSupportingFile = (method, filePath, content) => handleConfigBridgeMessage({
      id: 'skill-file-mutate',
      type: 'api:config/skills/files',
      payload: { method, name: 'cap-test-skill', filePath, content },
    }, createCtx(root), deps);

    const refused = await mutateSupportingFile('PUT', 'doc.txt', 'a'.repeat(SKILL_FILE_CAP + 1));
    expect(refused?.success).toBe(false);
    expect(refused?.error).toContain('too large');
    expect(fs.readFileSync(path.join(root, '.opencode', 'skills', 'cap-test-skill', 'doc.txt'), 'utf8')).toBe('original');

    const atCap = 'a'.repeat(SKILL_FILE_CAP);
    const written = await mutateSupportingFile('PUT', 'doc.txt', atCap);
    expect(written?.success).toBe(true);
    const readBack = await getSupportingFile(root, 'doc.txt');
    expect(readBack?.data).toEqual({ content: atCap });
  });

  test('preserves supporting-file PUT and DELETE behavior', async () => {
    const root = createProjectSkill({});

    const mutateSupportingFile = (method, filePath, content) => handleConfigBridgeMessage({
      id: 'skill-file-mutate',
      type: 'api:config/skills/files',
      payload: { method, name: 'cap-test-skill', filePath, content },
    }, createCtx(root), deps);

    const written = await mutateSupportingFile('PUT', 'nested/file.txt', 'hello');
    expect(written?.success).toBe(true);
    expect(written?.data).toEqual({ success: true });

    const read = await getSupportingFile(root, 'nested/file.txt');
    expect(read?.success).toBe(true);
    expect(read?.data).toEqual({ content: 'hello' });

    const deleted = await mutateSupportingFile('DELETE', 'nested/file.txt');
    expect(deleted?.success).toBe(true);
    expect(deleted?.data).toEqual({ success: true });

    const afterDelete = await getSupportingFile(root, 'nested/file.txt');
    expect(afterDelete?.success).toBe(false);
    expect(afterDelete?.error).toContain('not found');
  });
});

describe('VS Code config bridge skill supporting-file traversal (#2304)', () => {
  const createProjectSkillWithSecret = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-traversal-'));
    tempRoots.push(root);
    const skillDir = path.join(root, '.opencode', 'skills', 'traversal-test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: traversal-test-skill\ndescription: Traversal test skill\n---\n\nBody.\n',
      'utf8',
    );
    // Two levels above the skill dir: <root>/secret.txt
    fs.writeFileSync(path.join(root, 'secret.txt'), 'sibling-secret', 'utf8');
    return root;
  };

  const callFiles = (root, method, filePath, content) => handleConfigBridgeMessage({
    id: 'skill-file-traversal',
    type: 'api:config/skills/files',
    payload: { method, name: 'traversal-test-skill', filePath, content },
  }, createCtx(root), deps);

  test('rejects a traversal GET without returning the sibling content', async () => {
    const root = createProjectSkillWithSecret();

    const response = await callFiles(root, 'GET', '../../secret.txt');

    expect(response?.success).toBe(false);
    expect(response?.error).toBe('Invalid file path');
    expect(JSON.stringify(response)).not.toContain('sibling-secret');
  });

  test('rejects backslash and absolute traversal variants', async () => {
    const root = createProjectSkillWithSecret();

    for (const filePath of ['..\\..\\secret.txt', '/etc/passwd', 'nested/../../secret.txt']) {
      const response = await callFiles(root, 'GET', filePath);
      expect(response?.success).toBe(false);
      expect(response?.error).toBe('Invalid file path');
    }
  });

  test('rejects a traversal PUT and creates nothing outside the skill dir', async () => {
    const root = createProjectSkillWithSecret();

    const response = await callFiles(root, 'PUT', '../../pwned.txt', 'pwned');

    expect(response?.success).toBe(false);
    expect(response?.error).toBe('Invalid file path');
    expect(fs.existsSync(path.join(root, 'pwned.txt'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.opencode', 'pwned.txt'))).toBe(false);
  });

  test('rejects a traversal DELETE and removes nothing outside the skill dir', async () => {
    const root = createProjectSkillWithSecret();

    const response = await callFiles(root, 'DELETE', '../../secret.txt');

    expect(response?.success).toBe(false);
    expect(response?.error).toBe('Invalid file path');
    expect(fs.readFileSync(path.join(root, 'secret.txt'), 'utf8')).toBe('sibling-secret');
  });

  test('still serves a legitimate nested supporting file', async () => {
    const root = createProjectSkillWithSecret();
    const skillDir = path.join(root, '.opencode', 'skills', 'traversal-test-skill');
    fs.mkdirSync(path.join(skillDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'docs', 'guide.md'), 'guide', 'utf8');

    const response = await callFiles(root, 'GET', 'docs/guide.md');

    expect(response?.success).toBe(true);
    expect(response?.data).toEqual({ content: 'guide' });
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

describe('VS Code plugin switches', () => {
  test('switches an entry off in its own store and reports it in the list', async () => {
    const root = path.join(scratchConfigRoot, 'xdg', 'opencode');
    fs.mkdirSync(root, { recursive: true });
    tempRoots.push(root);
    process.env.OPENCODE_CONFIG = path.join(root, 'opencode.json');
    fs.writeFileSync(process.env.OPENCODE_CONFIG, JSON.stringify({ plugins: ['leakshield'] }));
    const storage = fs.mkdtempSync(path.join(scratchConfigRoot, 'storage-'));
    tempRoots.push(storage);
    const ctx = createCtx(root);
    ctx.context.globalStorageUri.fsPath = storage;

    const listed = await handleConfigBridgeMessage(
      { id: 'l', type: 'api:config/plugins', payload: { target: 'list', directory: root } },
      ctx,
      deps,
    );
    const entry = listed.data.entries.find((candidate) => candidate.spec === 'leakshield');
    expect(entry.switchState).toBe('on');

    const off = await handleConfigBridgeMessage({
      id: 'off',
      type: 'api:config/plugins',
      payload: { method: 'PUT', target: 'entry', action: 'enabled', pluginId: entry.id, body: { enabled: false }, directory: root },
    }, ctx, deps);
    expect(off.success).toBe(true);
    expect(off.data).toMatchObject({ enabled: false, resource: 'plugin:leakshield', changed: true, requiresManualRestart: false });
    expect(readJson(path.join(storage, 'plugin-switches.json'))).toEqual({ version: 1, disabled: ['plugin:leakshield'] });

    const after = await handleConfigBridgeMessage(
      { id: 'l2', type: 'api:config/plugins', payload: { target: 'list', directory: root } },
      ctx,
      deps,
    );
    expect(after.data.entries.find((candidate) => candidate.spec === 'leakshield').switchState).toBe('off');
  });

  test('keeps the saved switch and asks for a restart when the managed layer cannot be rewritten', async () => {
    const root = path.join(scratchConfigRoot, 'xdg', 'opencode');
    fs.mkdirSync(root, { recursive: true });
    tempRoots.push(root);
    process.env.OPENCODE_CONFIG = path.join(root, 'opencode.json');
    fs.writeFileSync(process.env.OPENCODE_CONFIG, JSON.stringify({ plugins: ['leakshield'] }));
    const storage = fs.mkdtempSync(path.join(scratchConfigRoot, 'storage-'));
    tempRoots.push(storage);
    const base = createCtx(root);
    base.context.globalStorageUri.fsPath = storage;
    const ctx = {
      ...base,
      manager: { ...base.manager, refreshPluginSwitches: async () => { throw new Error('disk full'); } },
    };

    const listed = await handleConfigBridgeMessage(
      { id: 'l', type: 'api:config/plugins', payload: { target: 'list', directory: root } },
      ctx,
      deps,
    );
    const entry = listed.data.entries.find((candidate) => candidate.spec === 'leakshield');
    const off = await handleConfigBridgeMessage({
      id: 'off',
      type: 'api:config/plugins',
      payload: { method: 'PUT', target: 'entry', action: 'enabled', pluginId: entry.id, body: { enabled: false }, directory: root },
    }, ctx, deps);

    expect(off.success).toBe(true);
    expect(off.data).toMatchObject({ enabled: false, changed: true, requiresReload: false, requiresManualRestart: true });
    expect(readJson(path.join(storage, 'plugin-switches.json'))).toEqual({ version: 1, disabled: ['plugin:leakshield'] });
  });

  test('reports a plugin a config allow keeps loading and refuses to switch it off', async () => {
    const root = path.join(scratchConfigRoot, 'xdg', 'opencode');
    fs.mkdirSync(root, { recursive: true });
    tempRoots.push(root);
    process.env.OPENCODE_CONFIG = path.join(root, 'opencode.json');
    fs.writeFileSync(process.env.OPENCODE_CONFIG, JSON.stringify({
      plugins: ['leakshield'],
      policies: [{ action: 'plugin.use', resource: '*', effect: 'allow' }],
    }));
    const storage = fs.mkdtempSync(path.join(scratchConfigRoot, 'storage-'));
    tempRoots.push(storage);
    const ctx = createCtx(root);
    ctx.context.globalStorageUri.fsPath = storage;

    const listed = await handleConfigBridgeMessage(
      { id: 'l', type: 'api:config/plugins', payload: { target: 'list', directory: root } },
      ctx,
      deps,
    );
    const entry = listed.data.entries.find((candidate) => candidate.spec === 'leakshield');
    expect(entry.switchState).toBe('overridden');

    let thrown;
    try {
      await handleConfigBridgeMessage({
        id: 'off',
        type: 'api:config/plugins',
        payload: { method: 'PUT', target: 'entry', action: 'enabled', pluginId: entry.id, body: { enabled: false }, directory: root },
      }, ctx, deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe('SWITCH_OVERRIDDEN');
    expect(fs.existsSync(path.join(storage, 'plugin-switches.json'))).toBe(false);
  });

  test('refuses a switch when the extension connects to an external OpenCode', async () => {
    const base = createCtx(os.tmpdir());
    const ctx = {
      ...base,
      manager: {
        ...base.manager,
        getDebugInfo: () => ({ mode: 'external' }),
      },
    };
    let thrown;
    try {
      await handleConfigBridgeMessage({
        id: 'x',
        type: 'api:config/plugins',
        payload: { method: 'PUT', target: 'entry', action: 'enabled', pluginId: 'id', body: { enabled: false } },
      }, ctx, deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.code).toBe('SWITCH_UNAVAILABLE');
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
