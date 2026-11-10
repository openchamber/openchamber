import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

import { registerPluginRoutes } from './plugin-routes.js';
import { createPluginSwitchStore } from './plugin-switches.js';

let projectDir;
let userConfigPath;
let rootDir;
let globalPluginsDir;
let switchStorePath;
let switchStore;
let plugins;
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
let refreshOpenCodeAfterConfigChange;
let refreshPluginSwitches;
let isPluginSwitchAvailable;
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
    setPluginEntryEnabled: plugins.setPluginEntryEnabled,
    setPluginFileEnabled: plugins.setPluginFileEnabled,
    listPluginDirFiles: plugins.listPluginDirFiles,
    readPluginDirFile: plugins.readPluginDirFile,
    writePluginDirFile: plugins.writePluginDirFile,
    deletePluginDirFile: plugins.deletePluginDirFile,
    encodePluginId: plugins.encodePluginId,
    decodePluginId: plugins.decodePluginId,
    pluginSwitchStore: switchStore,
    isPluginSwitchAvailable: () => isPluginSwitchAvailable,
    refreshPluginSwitches,
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
    switchStorePath = path.join(rootDir, 'plugin-switches.json');
    // The global config folder is read at import; keep it off the real one.
    // User plugin files land in its `plugins/`, the folder OpenCode scans.
    process.env.OPENCODE_CONFIG_DIR = path.join(rootDir, 'global');
    globalPluginsDir = path.join(rootDir, 'global', 'plugins');
    process.env.OPENCODE_CONFIG = userConfigPath;
    plugins = await import('./plugins.js');
  });

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(rootDir, 'project-'));
    fs.rmSync(userConfigPath, { force: true });
    fs.rmSync(switchStorePath, { force: true });
    fs.rmSync(globalPluginsDir, { recursive: true, force: true });
    switchStore = createPluginSwitchStore({ filePath: switchStorePath });
    refreshOpenCodeAfterConfigChange = mock(async () => undefined);
    refreshPluginSwitches = mock(async () => ({ updated: true }));
    isPluginSwitchAvailable = true;
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
    if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
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

  test('GET /registry reports a Git spec as its own kind without querying npm', async () => {
    // Before this, a Git spec fell through to the npm branch: the registry was
    // queried with the literal spec and answered 405, so a working plugin showed
    // as an unreachable registry.
    const getNpmInfo = mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } }));
    createRegistryApp(getNpmInfo);

    const response = await request(app)
      .get(`/api/config/plugins/registry?specs=${encodeURIComponent('github:acme/opencode-plugin')}`)
      .expect(200);

    expect(response.body.results[0]).toEqual({ kind: 'git-ok', spec: 'github:acme/opencode-plugin' });
    expect(getNpmInfo).not.toHaveBeenCalled();
  });

  test('GET /registry skips control entries without querying npm', async () => {
    // `-hooks` disables a plugin; querying npm for it answered 404 and the card
    // showed it as an invalid plugin.
    const getNpmInfo = mock(async () => ({ ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } }));
    createRegistryApp(getNpmInfo);

    const response = await request(app)
      .get(`/api/config/plugins/registry?specs=${['-hooks', '*', 'foo'].map(encodeURIComponent).join(',')}`)
      .expect(200);

    expect(response.body.results.map((result) => result.spec)).toEqual(['foo']);
    expect(getNpmInfo).toHaveBeenCalledTimes(1);
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

  test('POST /entry creates entry and defers restart', async () => {
    const response = await createEntry('a');

    expect(response.body).toMatchObject({
      success: true,
      message: 'Plugin entry created.',
    });
    expect(refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
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

  test('POST a spec OpenCode cannot load returns 400 with its code and adds nothing', async () => {
    const response = await request(app)
      .post('/api/config/plugins/entry')
      .send({ spec: 'https://example.com/plugin.tgz', scope: 'user' })
      .expect(400);

    expect(response.body.code).toBe('UNLOADABLE_SPEC');
    const after = await request(app).get('/api/config/plugins').expect(200);
    expect(after.body.entries).toEqual([]);
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
    expect(response.body).toMatchObject({
      message: 'Plugin entry updated.',
    });
    const after = await request(app).get('/api/config/plugins').expect(200);
    expect(after.body.entries[0]).toEqual(expect.objectContaining({ spec: 'b', scope: 'user' }));
    expect(refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });

  test('DELETE /entry/:id removes entry and prunes plugin key', async () => {
    await createEntry('a');
    const listed = await request(app).get('/api/config/plugins').expect(200);
    const id = listed.body.entries[0].id;

    const response = await request(app).delete(`/api/config/plugins/entry/${encodeURIComponent(id)}`).expect(200);

    const after = await request(app).get('/api/config/plugins').expect(200);
    expect(after.body.entries).toEqual([]);
    expect(readJson(userConfigPath).plugin).toBeUndefined();
    expect(response.body).toMatchObject({
      success: true,
      message: 'Plugin entry deleted.',
    });
    expect(refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });

  test('POST /file writes plugin dir file', async () => {
    const response = await createFile('test.js', '//x');

    expect(response.body).toMatchObject({
      success: true,
      message: 'Plugin file created.',
    });
    expect(fs.readFileSync(path.join(globalPluginsDir, 'test.js'), 'utf8')).toBe('//x');
    expect(refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
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

    const response = await request(app)
      .put(`/api/config/plugins/file/${encodeURIComponent(id)}`)
      .send({ content: '//y' })
      .expect(200);

    expect(fs.readFileSync(path.join(globalPluginsDir, 'test.js'), 'utf8')).toBe('//y');
    expect(response.body).toMatchObject({
      success: true,
      message: 'Plugin file updated.',
    });
    expect(refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });

  test('DELETE /file/:id unlinks file', async () => {
    await createFile('test.js', '//x');
    const listed = await request(app).get('/api/config/plugins').expect(200);
    const id = listed.body.files[0].id;

    const response = await request(app).delete(`/api/config/plugins/file/${encodeURIComponent(id)}`).expect(200);

    expect(fs.existsSync(path.join(globalPluginsDir, 'test.js'))).toBe(false);
    expect(response.body).toMatchObject({
      success: true,
      message: 'Plugin file deleted.',
    });
    expect(refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });

  test('PUT /entry/:id/enabled records the switch and refreshes the managed config', async () => {
    await createEntry('switched');
    const id = plugins.encodePluginId('config', 'user:switched');

    const off = await request(app)
      .put(`/api/config/plugins/entry/${encodeURIComponent(id)}/enabled`)
      .send({ enabled: false })
      .expect(200);
    expect(off.body).toMatchObject({ enabled: false, changed: true });
    expect(switchStore.read()).toEqual({ ok: true, resources: ['plugin:switched'] });
    // The user's own config is never given the deny.
    expect(readJson(userConfigPath).policies).toBeUndefined();
    expect(refreshPluginSwitches).toHaveBeenCalledTimes(1);

    const on = await request(app)
      .put(`/api/config/plugins/entry/${encodeURIComponent(id)}/enabled`)
      .send({ enabled: true })
      .expect(200);
    expect(on.body).toMatchObject({ enabled: true, changed: true });
    expect(switchStore.read()).toEqual({ ok: true, resources: [] });
  });

  test('PUT /entry/:id/enabled asks for a restart when the managed config cannot be rewritten', async () => {
    await createEntry('switched');
    const id = plugins.encodePluginId('config', 'user:switched');
    refreshPluginSwitches = mock(async () => ({ updated: false, reason: 'external-config' }));
    app = createApp();

    const response = await request(app)
      .put(`/api/config/plugins/entry/${encodeURIComponent(id)}/enabled`)
      .send({ enabled: false })
      .expect(200);
    expect(response.body).toMatchObject({ enabled: false, changed: true, requiresManualRestart: true });
  });

  test('PUT /entry/:id/enabled keeps the saved switch when rewriting the managed config fails', async () => {
    await createEntry('switched');
    const id = plugins.encodePluginId('config', 'user:switched');
    refreshPluginSwitches = mock(async () => { throw new Error('disk full'); });
    app = createApp();

    const response = await request(app)
      .put(`/api/config/plugins/entry/${encodeURIComponent(id)}/enabled`)
      .send({ enabled: false })
      .expect(200);
    expect(response.body).toMatchObject({ enabled: false, changed: true, requiresManualRestart: true });
    expect(switchStore.read()).toEqual({ ok: true, resources: ['plugin:switched'] });
  });

  test('PUT /entry/:id/enabled refuses an external OpenCode', async () => {
    await createEntry('switched');
    const id = plugins.encodePluginId('config', 'user:switched');
    isPluginSwitchAvailable = false;
    app = createApp();

    const list = await request(app).get('/api/config/plugins').expect(200);
    expect(list.body.entries[0].switchState).toBe('unavailable');

    const response = await request(app)
      .put(`/api/config/plugins/entry/${encodeURIComponent(id)}/enabled`)
      .send({ enabled: false })
      .expect(409);
    expect(response.body.code).toBe('SWITCH_UNAVAILABLE');
    expect(switchStore.read()).toEqual({ ok: true, resources: [] });
  });

  test('PUT /entry/:id/enabled refuses a denial a config allow would beat', async () => {
    await createEntry('switched');
    const config = readJson(userConfigPath);
    const allow = { action: 'plugin.use', resource: '*', effect: 'allow' };
    fs.writeFileSync(userConfigPath, JSON.stringify({ ...config, policies: [allow] }), 'utf8');
    const id = plugins.encodePluginId('config', 'user:switched');

    const list = await request(app).get('/api/config/plugins').expect(200);
    expect(list.body.entries[0].switchState).toBe('overridden');

    const response = await request(app)
      .put(`/api/config/plugins/entry/${encodeURIComponent(id)}/enabled`)
      .send({ enabled: false })
      .expect(409);
    expect(response.body.code).toBe('SWITCH_OVERRIDDEN');
    expect(switchStore.read()).toEqual({ ok: true, resources: [] });
    expect(readJson(userConfigPath).policies).toEqual([allow]);
    expect(refreshPluginSwitches).not.toHaveBeenCalled();
  });

  test('PUT /entry/:id/enabled rejects a value that is not a boolean', async () => {
    await createEntry('switched');
    const id = plugins.encodePluginId('config', 'user:switched');

    const response = await request(app)
      .put(`/api/config/plugins/entry/${encodeURIComponent(id)}/enabled`)
      .send({ enabled: 'yes' })
      .expect(400);
    expect(response.body.code).toBe('INVALID_STATE');
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
