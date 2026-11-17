import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    manager: {
      getWorkingDirectory: () => workingDirectory,
      restart,
    },
  };
};

const deps = {
  readSettings: () => ({}),
  persistSettings: async (changes) => changes,
  readMagicPromptOverrides: () => ({ version: 1, overrides: {} }),
  saveMagicPromptOverride: async () => ({ version: 1, overrides: {} }),
  resetMagicPromptOverride: async () => ({ version: 1, overrides: {} }),
  resetAllMagicPromptOverrides: async () => ({ version: 1, overrides: {} }),
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

  test('writes user plugin files next to OPENCODE_CONFIG', async () => {
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
    expect(fs.readFileSync(path.join(configDir, 'plugins', 'demo-plugin.ts'), 'utf8')).toBe('export default {}');
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
