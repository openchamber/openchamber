import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { connectReplacementProvider, retireReplacedPlugins } from './retired-plugins.js';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop(), { recursive: true, force: true });
});

const layersFor = (userPath, userConfig, { overridePath = null, overrideConfig = {}, layerErrors = [] } = {}) => () => ({
  paths: { userPath, userOverridePath: overridePath, projectPath: null, customPath: null },
  userConfig: structuredClone(userConfig),
  userOverrideConfig: structuredClone(overrideConfig),
  projectConfig: {},
  customConfig: {},
  mergedConfig: {},
  layerErrors,
});

describe('retireReplacedPlugins', () => {
  it('drops every form of the opencode-claude entry and keeps the rest of the file, comments included', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-retired-'));
    tempDirs.push(dir);
    const userPath = path.join(dir, 'opencode.jsonc');
    const config = {
      model: 'claude-code/claude-opus-5-5',
      plugins: ['@openchamber/opencode-claude@1.7.0', 'acme-plugin', ['@openchamber/opencode-claude', { effort: 'high' }]],
      plugin: ['@openchamber/opencode-claude'],
    };
    await fs.writeFile(userPath, `// mine\n${JSON.stringify(config, null, 2)}\n`);

    const { writeConfig } = await import('./config-files.js');
    expect(retireReplacedPlugins({ readLayers: layersFor(userPath, config), writeLayer: writeConfig })).toEqual([userPath]);

    const text = await fs.readFile(userPath, 'utf8');
    expect(text.startsWith('// mine\n')).toBe(true);
    expect(JSON.parse(text.slice('// mine\n'.length))).toEqual({ model: 'claude-code/claude-opus-5-5', plugins: ['acme-plugin'], plugin: [] });
  });

  it('leaves configs without the plugin, and an unreadable one, unwritten', () => {
    const writes = [];
    const result = retireReplacedPlugins({
      readLayers: layersFor('/cfg/opencode.json', { plugins: ['acme-plugin'] }, {
        overridePath: '/cfg/opencode.jsonc',
        overrideConfig: { plugins: ['@openchamber/opencode-claude'] },
        layerErrors: [{ path: '/cfg/opencode.jsonc', code: 'INVALID', message: 'bad' }],
      }),
      writeLayer: (config, filePath) => writes.push(filePath),
    });
    expect(result).toEqual([]);
    expect(writes).toEqual([]);
  });
});

const openCode = (answers) => {
  const requests = [];
  return {
    requests,
    connection: {
      buildOpenCodeUrl: (requestPath) => `http://opencode${requestPath}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic x' }),
      directory: '/work',
      retryMs: 0,
      fetchImpl: async (url, init) => {
        requests.push({ url, method: init.method ?? 'GET', directory: init.headers.get('x-opencode-directory'), body: init.body });
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
      },
    },
  };
};

describe('connectReplacementProvider', () => {
  it('waits for OpenCode and the Claude Agent integration, then connects it through the Claude Code login', async () => {
    const { requests, connection } = openCode([
      new Error('connection refused'),
      { status: 404 },
      { status: 200, body: { data: { connections: [] } } },
      { status: 204 },
    ]);
    expect(await connectReplacementProvider(connection)).toBe('connected');
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET http://opencode/api/integration/claude-agent',
      'GET http://opencode/api/integration/claude-agent',
      'GET http://opencode/api/integration/claude-agent',
      'POST http://opencode/api/integration/claude-agent/connect/external',
    ]);
    expect(requests.at(-1)).toMatchObject({ directory: '%2Fwork', body: '{"methodID":"claude-login"}' });
  });

  it('leaves a Claude Agent connection the user already has alone', async () => {
    const { requests, connection } = openCode([{ status: 200, body: { data: { connections: [{ id: 'mine' }] } } }]);
    expect(await connectReplacementProvider(connection)).toBe('already-connected');
    expect(requests).toHaveLength(1);
  });

  it('fails when OpenCode refuses the connection', async () => {
    const { connection } = openCode([{ status: 200, body: { data: { connections: [] } } }, { status: 500 }]);
    await expect(connectReplacementProvider(connection)).rejects.toThrow('500');
  });
});
