import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

import { registerPluginRoutes } from './plugin-routes.js';

let projectDir;
let userConfigPath;
let rootDir;
let plugins;
let refreshOpenCodeAfterConfigChange;
let app;
let cleanupPaths;

const testUnlessRoot = typeof process.getuid === 'function' && process.getuid() === 0 ? test.skip : test;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createApp(overrides = {}) {
  const testApp = express();
  testApp.use(express.json());
  registerPluginRoutes(testApp, {
    resolveOptionalProjectDirectory: async () => ({ directory: projectDir, error: null }),
    refreshOpenCodeAfterConfigChange,
    clientReloadDelayMs: 25,
    listPluginEntries: plugins.listPluginEntries,
    getPluginEntry: plugins.getPluginEntry,
    createPluginEntry: plugins.createPluginEntry,
    updatePluginEntry: plugins.updatePluginEntry,
    deletePluginEntry: plugins.deletePluginEntry,
    listPluginDirFiles: plugins.listPluginDirFiles,
    readPluginDirFile: plugins.readPluginDirFile,
    writePluginDirFile: plugins.writePluginDirFile,
    deletePluginDirFile: plugins.deletePluginDirFile,
    encodePluginId: plugins.encodePluginId,
    decodePluginId: plugins.decodePluginId,
    ...overrides,
  });
  return testApp;
}

function createRegistryApp(getNpmInfo) {
  app = createApp({ getNpmInfo });
  return app;
}

async function createEntry(spec = 'a') {
  return request(app)
    .post('/api/config/plugins/entry')
    .send({ spec, scope: 'user' })
    .expect(200);
}

async function createFile(fileName = 'test.js', content = '//x') {
  return request(app)
    .post('/api/config/plugins/file')
    .send({ fileName, content, scope: 'user' })
    .expect(200);
}

describe('opencode plugin routes', () => {
  beforeAll(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-plugin-routes-'));
    userConfigPath = path.join(rootDir, 'user-opencode.json');
    process.env.OPENCODE_CONFIG = userConfigPath;
    plugins = await import('./plugins.js');
  });

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(rootDir, 'project-'));
    fs.rmSync(userConfigPath, { force: true });
    fs.rmSync(path.join(rootDir, 'plugins'), { recursive: true, force: true });
    refreshOpenCodeAfterConfigChange = mock(async () => undefined);
    cleanupPaths = [];
    app = createApp();
  });

  afterEach(() => {
    for (const target of cleanupPaths) {
      try {
        fs.chmodSync(target, 0o600);
      } catch {
      }
    }
  });

  afterAll(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    delete process.env.OPENCODE_CONFIG;
  });

  test('GET /api/config/plugins empty returns entries and files arrays', async () => {
    const response = await request(app).get('/api/config/plugins').expect(200);

    expect(response.body).toEqual({ entries: [], files: [] });
  });

  test('GET /registry with empty specs returns empty results', async () => {
    const getNpmInfo = mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } }));
    createRegistryApp(getNpmInfo);

    const response = await request(app).get('/api/config/plugins/registry?specs=').expect(200);

    expect(response.body).toEqual({ results: [] });
    expect(getNpmInfo).not.toHaveBeenCalled();
  });

  test('GET /registry reports update for exact npm version behind latest', async () => {
    createRegistryApp(mock(async () => ({ ok: true, latest: '2.0.0', versions: ['1.0.0', '2.0.0'], distTags: { latest: '2.0.0' } })));

    const response = await request(app).get('/api/config/plugins/registry?specs=foo@1.0.0').expect(200);

    expect(response.body.results[0]).toMatchObject({
      kind: 'npm-ok',
      spec: 'foo@1.0.0',
      name: 'foo',
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      hasUpdate: true,
    });
  });

  test('GET /registry reports no update when exact npm version matches latest', async () => {
    createRegistryApp(mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } })));

    const response = await request(app).get('/api/config/plugins/registry?specs=foo@1.0.0').expect(200);

    expect(response.body.results[0]).toMatchObject({ kind: 'npm-ok', hasUpdate: false, latestVersion: '1.0.0', currentVersion: '1.0.0' });
  });

  test('GET /registry reports missing exact npm version', async () => {
    createRegistryApp(mock(async () => ({ ok: true, latest: '2.0.0', versions: ['1.0.0', '2.0.0'], distTags: { latest: '2.0.0' } })));

    const response = await request(app).get('/api/config/plugins/registry?specs=foo@99.99.99').expect(200);

    expect(response.body.results[0]).toMatchObject({ kind: 'npm-missing-version', name: 'foo', currentVersion: '99.99.99', latestVersion: '2.0.0' });
  });

  test('GET /registry reports missing npm package', async () => {
    createRegistryApp(mock(async () => ({ ok: false, status: 404, error: 'Package not found' })));

    const response = await request(app).get('/api/config/plugins/registry?specs=nonexistent@1.0.0').expect(200);

    expect(response.body.results[0]).toMatchObject({ kind: 'npm-missing-package', spec: 'nonexistent@1.0.0', name: 'nonexistent', error: 'Package not found' });
  });

  test('GET /registry reports malformed npm spec', async () => {
    const getNpmInfo = mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } }));
    createRegistryApp(getNpmInfo);

    const response = await request(app).get('/api/config/plugins/registry?specs=%40%40malformed').expect(200);

    expect(response.body.results[0]).toEqual({ kind: 'npm-malformed', spec: '@@malformed', error: 'Spec syntax is malformed' });
    expect(getNpmInfo).not.toHaveBeenCalled();
  });

  test('GET /registry reports existing path plugin ok', async () => {
    createRegistryApp(mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } })));
    const tmpFile = path.join(fs.mkdtempSync(path.join(rootDir, 'plugin-path-')), 'plugin.js');
    fs.writeFileSync(tmpFile, '// plugin', 'utf8');

    const response = await request(app).get(`/api/config/plugins/registry?specs=${encodeURIComponent(tmpFile)}`).expect(200);

    expect(response.body.results[0]).toEqual({ kind: 'path-ok', spec: tmpFile, absolutePath: tmpFile });
  });

  test('GET /registry reports missing path plugin', async () => {
    createRegistryApp(mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } })));

    const response = await request(app).get('/api/config/plugins/registry?specs=%2Fnonexistent%2F__path%2Fxyz.js').expect(200);

    expect(response.body.results[0]).toEqual({ kind: 'path-missing', spec: '/nonexistent/__path/xyz.js', absolutePath: '/nonexistent/__path/xyz.js' });
  });

  test('GET /registry treats Windows absolute paths as local paths', async () => {
    const getNpmInfo = mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } }));
    createRegistryApp(getNpmInfo);

    const windowsPath = 'C:\\Users\\me\\plugin.js';
    const response = await request(app)
      .get(`/api/config/plugins/registry?specs=${encodeURIComponent(windowsPath)}`)
      .expect(200);

    expect(response.body.results[0]).toEqual({ kind: 'path-missing', spec: windowsPath, absolutePath: windowsPath });
    expect(getNpmInfo).not.toHaveBeenCalled();
  });

  testUnlessRoot('GET /registry reports unreadable path plugin', async () => {
    createRegistryApp(mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } })));
    const tmpFile = path.join(fs.mkdtempSync(path.join(rootDir, 'plugin-unreadable-')), 'plugin.js');
    fs.writeFileSync(tmpFile, '// plugin', 'utf8');
    cleanupPaths.push(tmpFile);
    fs.chmodSync(tmpFile, 0);

    const response = await request(app).get(`/api/config/plugins/registry?specs=${encodeURIComponent(tmpFile)}`).expect(200);

    expect(response.body.results[0]).toEqual({ kind: 'path-unreadable', spec: tmpFile, absolutePath: tmpFile });
  });

  test('GET /registry reports npm network failure without failing route', async () => {
    createRegistryApp(mock(async () => ({ ok: false, status: 'network', error: 'socket closed' })));

    const response = await request(app).get('/api/config/plugins/registry?specs=foo@1.0.0').expect(200);

    expect(response.body.results[0]).toMatchObject({ kind: 'npm-network', spec: 'foo@1.0.0', error: 'socket closed' });
  });

  test('GET /registry deduplicates npm package lookups by name', async () => {
    const getNpmInfo = mock(async () => ({ ok: true, latest: '3.0.0', versions: ['1', '2', '3'], distTags: { latest: '3.0.0' } }));
    createRegistryApp(getNpmInfo);

    await request(app).get('/api/config/plugins/registry?specs=foo@1,foo@2,foo@3').expect(200);

    expect(getNpmInfo).toHaveBeenCalledTimes(1);
    expect(getNpmInfo).toHaveBeenCalledWith('foo', { forceRefresh: false });
  });

  test('GET /registry forwards refresh true to npm lookup', async () => {
    const getNpmInfo = mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } }));
    createRegistryApp(getNpmInfo);

    await request(app).get('/api/config/plugins/registry?specs=foo&refresh=true').expect(200);

    expect(getNpmInfo).toHaveBeenCalledWith('foo', { forceRefresh: true });
  });

  test('GET /registry rejects more than 100 unique specs', async () => {
    const specs = Array.from({ length: 101 }, (_, index) => `pkg-${index}`).join(',');

    const response = await request(app).get(`/api/config/plugins/registry?specs=${specs}`).expect(400);

    expect(response.body).toEqual({ error: 'too many specs' });
  });

  test('GET /registry reports bare npm name with null current version', async () => {
    createRegistryApp(mock(async () => ({ ok: true, latest: '2.0.0', versions: ['1.0.0', '2.0.0'], distTags: { latest: '2.0.0' } })));

    const response = await request(app).get('/api/config/plugins/registry?specs=foo').expect(200);

    expect(response.body.results[0]).toMatchObject({ kind: 'npm-ok', spec: 'foo', name: 'foo', currentVersion: null, hasUpdate: false });
  });

  test('GET /registry accepts non-exact npm range without missing-version noise', async () => {
    createRegistryApp(mock(async () => ({ ok: true, latest: '2.0.0', versions: ['1.0.0', '2.0.0'], distTags: { latest: '2.0.0' } })));

    const response = await request(app).get('/api/config/plugins/registry?specs=foo@%5E1.0').expect(200);

    expect(response.body.results[0]).toMatchObject({ kind: 'npm-ok', spec: 'foo@^1.0', name: 'foo', currentVersion: '^1.0', hasUpdate: false });
  });

  test('GET /registry supports scoped npm package specs', async () => {
    const getNpmInfo = mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } }));
    createRegistryApp(getNpmInfo);

    const response = await request(app).get('/api/config/plugins/registry?specs=%40scope%2Ffoo%401.0.0').expect(200);

    expect(getNpmInfo).toHaveBeenCalledWith('@scope/foo', { forceRefresh: false });
    expect(response.body.results[0]).toMatchObject({ kind: 'npm-ok', spec: '@scope/foo@1.0.0', name: '@scope/foo' });
  });

  test('POST /entry creates entry and requires reload', async () => {
    const response = await createEntry('a');

    expect(response.body).toMatchObject({ success: true, requiresReload: true, reloadDelayMs: 25 });
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin entry creation');
  });

  test('GET after POST returns created entry', async () => {
    await createEntry('a');

    const response = await request(app).get('/api/config/plugins').expect(200);

    expect(response.body.entries).toEqual([expect.objectContaining({ spec: 'a', scope: 'user' })]);
  });

  test('POST duplicate entry returns 409', async () => {
    await createEntry('a');

    const response = await request(app)
      .post('/api/config/plugins/entry')
      .send({ spec: 'a', scope: 'user' })
      .expect(409);

    expect(response.body.error).toContain('already exists');
  });

  test('generic entry mutations cannot change Secure Workspace plugin configuration', async () => {
    const reservedSpec = '@openchamber/opencode-container-workspace';
    const deniedCreate = await request(app)
      .post('/api/config/plugins/entry')
      .send({ spec: reservedSpec, scope: 'user' })
      .expect(409);
    expect(deniedCreate.body.error).toContain('workspace settings endpoint');

    plugins.createPluginEntry({ spec: reservedSpec, options: { enabled: true }, scope: 'user' }, projectDir);
    const listed = await request(app).get('/api/config/plugins').expect(200);
    const id = listed.body.entries[0].id;

    await request(app).patch(`/api/config/plugins/entry/${encodeURIComponent(id)}`).send({ options: { enabled: false } }).expect(409);
    await request(app).delete(`/api/config/plugins/entry/${encodeURIComponent(id)}`).expect(409);
    expect(plugins.getPluginEntry(id, projectDir)?.options).toEqual({ enabled: true });
    expect(refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });

  test('generic entry update cannot replace a regular plugin with the workspace plugin', async () => {
    await createEntry('a');
    const listed = await request(app).get('/api/config/plugins').expect(200);

    await request(app)
      .patch(`/api/config/plugins/entry/${encodeURIComponent(listed.body.entries[0].id)}`)
      .send({ spec: '/tmp/opencode-container-workspace/src/plugin.js' })
      .expect(409);

    expect(plugins.getPluginEntry(listed.body.entries[0].id, projectDir)?.spec).toBe('a');
  });

  test('generic entry mutations reject an explicitly resolved workspace plugin path', async () => {
    const explicitSpec = '/custom/plugin.js';
    app = createApp({ getWorkspacePluginSpec: () => explicitSpec });
    plugins.createPluginEntry({ spec: explicitSpec, scope: 'user' }, projectDir);
    const listed = await request(app).get('/api/config/plugins').expect(200);
    const id = listed.body.entries[0].id;

    await request(app).patch(`/api/config/plugins/entry/${encodeURIComponent(id)}`).send({ options: {} }).expect(409);
    await request(app).delete(`/api/config/plugins/entry/${encodeURIComponent(id)}`).expect(409);
    await request(app).post('/api/config/plugins/entry').send({ spec: '/custom/../custom/plugin.js', scope: 'user' }).expect(409);
  });

  test('generic entry creation rejects a symlink to the resolved workspace plugin', async () => {
    const pluginDirectory = fs.mkdtempSync(path.join(rootDir, 'workspace-plugin-'));
    const explicitSpec = path.join(pluginDirectory, 'plugin.js');
    const aliasSpec = path.join(pluginDirectory, 'alias.js');
    fs.writeFileSync(explicitSpec, 'export default {}\n');
    fs.symlinkSync(explicitSpec, aliasSpec);
    app = createApp({ getWorkspacePluginSpec: () => explicitSpec });

    await request(app).post('/api/config/plugins/entry').send({ spec: aliasSpec, scope: 'user' }).expect(409);
  });

  test('PATCH /entry/:id updates entry in same array index', async () => {
    await createEntry('a');
    const before = await request(app).get('/api/config/plugins').expect(200);
    const id = before.body.entries[0].id;

    const response = await request(app)
      .patch(`/api/config/plugins/entry/${encodeURIComponent(id)}`)
      .send({ spec: 'b' })
      .expect(200);

    expect(response.body.success).toBe(true);
    const after = await request(app).get('/api/config/plugins').expect(200);
    expect(after.body.entries[0]).toEqual(expect.objectContaining({ spec: 'b', scope: 'user' }));
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin entry update');
  });

  test('DELETE /entry/:id removes entry and prunes plugin key', async () => {
    await createEntry('a');
    const listed = await request(app).get('/api/config/plugins').expect(200);
    const id = listed.body.entries[0].id;

    await request(app).delete(`/api/config/plugins/entry/${encodeURIComponent(id)}`).expect(200);

    const after = await request(app).get('/api/config/plugins').expect(200);
    expect(after.body.entries).toEqual([]);
    expect(readJson(userConfigPath).plugin).toBeUndefined();
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin entry deletion');
  });

  test('POST /file writes plugin dir file', async () => {
    const response = await createFile('test.js', '//x');

    expect(response.body).toMatchObject({ success: true, requiresReload: true });
    expect(fs.readFileSync(path.join(rootDir, 'plugins', 'test.js'), 'utf8')).toBe('//x');
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin file creation');
  });

  test('POST duplicate file returns 409', async () => {
    await createFile('test.js', '//x');

    const response = await request(app)
      .post('/api/config/plugins/file')
      .send({ fileName: 'test.js', content: '//again', scope: 'user' })
      .expect(409);

    expect(response.body.error).toContain('already exists');
  });

  test('PUT /file/:id updates file content', async () => {
    await createFile('test.js', '//x');
    const listed = await request(app).get('/api/config/plugins').expect(200);
    const id = listed.body.files[0].id;

    await request(app)
      .put(`/api/config/plugins/file/${encodeURIComponent(id)}`)
      .send({ content: '//y' })
      .expect(200);

    expect(fs.readFileSync(path.join(rootDir, 'plugins', 'test.js'), 'utf8')).toBe('//y');
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin file update');
  });

  test('DELETE /file/:id unlinks file', async () => {
    await createFile('test.js', '//x');
    const listed = await request(app).get('/api/config/plugins').expect(200);
    const id = listed.body.files[0].id;

    await request(app).delete(`/api/config/plugins/file/${encodeURIComponent(id)}`).expect(200);

    expect(fs.existsSync(path.join(rootDir, 'plugins', 'test.js'))).toBe(false);
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('plugin file deletion');
  });

  test('PATCH unknown entry id returns 404', async () => {
    const id = plugins.encodePluginId('config', 'user:missing');

    const response = await request(app)
      .patch(`/api/config/plugins/entry/${encodeURIComponent(id)}`)
      .send({ spec: 'b' })
      .expect(404);

    expect(response.body.error).toContain('not found');
  });

  test('POST invalid fileName returns 400', async () => {
    const response = await request(app)
      .post('/api/config/plugins/file')
      .send({ fileName: '../escape.js', content: '//x', scope: 'user' })
      .expect(400);

    expect(response.body.error).toContain('Plugin file name');
  });
});
