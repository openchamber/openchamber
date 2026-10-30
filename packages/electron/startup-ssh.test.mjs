import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { connectDefaultSshInstanceAtStartup, resolveDefaultSshInstanceId } from './startup-ssh.mjs';

const fakeManager = (connect) => {
  const disconnected = [];
  return {
    disconnected,
    connect,
    disconnect: async (id) => { disconnected.push(id); },
  };
};

test('only an SSH instance id counts as the default SSH instance', () => {
  const instances = [{ id: 'ssh-1' }];
  assert.equal(resolveDefaultSshInstanceId('ssh-1', instances), 'ssh-1');
  assert.equal(resolveDefaultSshInstanceId('local', instances), null);
  assert.equal(resolveDefaultSshInstanceId('', instances), null);
});

test('a ready tunnel resolves ok and keeps the connection', async () => {
  const manager = fakeManager(async () => {});
  assert.deepEqual(await connectDefaultSshInstanceAtStartup({ sshManager: manager, instanceId: 'ssh-1' }), { ok: true });
  assert.deepEqual(manager.disconnected, []);
});

test('a failed connect reports why and tears the attempt down', async () => {
  const manager = fakeManager(async () => { throw new Error('Permission denied'); });
  const result = await connectDefaultSshInstanceAtStartup({ sshManager: manager, instanceId: 'ssh-1' });
  assert.deepEqual(result, { ok: false, reason: 'Permission denied' });
  assert.deepEqual(manager.disconnected, ['ssh-1']);
});

test('a connect that outlasts the bound is stopped', async () => {
  const manager = fakeManager(() => new Promise(() => {}));
  const result = await connectDefaultSshInstanceAtStartup({ sshManager: manager, instanceId: 'ssh-1', timeoutMs: 10 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.deepEqual(manager.disconnected, ['ssh-1']);
});

test('native windows retain a failed SSH startup fallback without changing serverless environment targets', async () => {
  // Run the native selector bodies without importing Electron or starting a server.
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const start = main.indexOf('const openMainWindow = async () => {');
  const reopen = main.slice(start, main.indexOf('\n};', start) + 4);
  const newWindow = main.slice(main.indexOf("    case 'desktop_new_window': {"), main.indexOf("    case 'desktop_new_window_for_host': {"));
  const host = { id: 'ssh-1', url: 'http://127.0.0.1:43001/', apiUrl: 'http://127.0.0.1:43001/', clientToken: 'fixture-ssh', requestHeaders: { 'X-Fixture-Ssh': 'remote' } };
  const local = { apiBaseUrl: 'http://127.0.0.1:3000', clientToken: 'fixture-local', requestHeaders: {} };
  for (const packaged of [true, false]) {
    for (const marker of ['ssh-1', 'another-host', null]) {
      const calls = [];
      const state = { startupResolved: true, sidecarUrl: local.apiBaseUrl, localOrigin: local.apiBaseUrl, apiBaseUrl: 'https://other.example.test', clientToken: 'fixture-other', unreachableHosts: new Set(), bootOutcome: { target: 'local', status: 'ok', sshStartupFallbackHostId: marker } };
      const context = {
        state, LOCAL_HOST_ID: 'local',
        readDesktopHostsConfig: () => ({ defaultHostId: host.id, hosts: [host] }),
        readDesktopLocalClientToken: () => local.clientToken,
        shouldUsePackagedUi: () => packaged,
        buildPackagedUiUrl: () => 'openchamber-ui://app/index.html',
        normalizeHostUrl: (url) => url,
        sanitizeClientTokenForStorage: (token) => token,
        sanitizeRuntimeRequestHeaders: (headers) => headers,
        resolveStoredClientTokenForUrl: () => '',
        activateMainWindow: async (url, origin, outcome, runtime) => calls.push(structuredClone({ url, runtime })),
        createAdditionalWindow: async (url, runtime) => calls.push(structuredClone({ url, runtime })),
      };
      await runInNewContext(`(async () => { ${reopen}; await openMainWindow(); switch ('desktop_new_window') { ${newWindow} } })()`, context);
      const runtime = marker === host.id ? local : { apiBaseUrl: host.apiUrl, clientToken: host.clientToken, requestHeaders: host.requestHeaders };
      const url = packaged ? 'openchamber-ui://app/index.html' : marker === host.id ? local.apiBaseUrl : host.url;
      assert.deepEqual(calls, [{ url, runtime }, { url, runtime }]);
    }
  }
  for (const defaultHostId of [null, 'local']) {
    const env = { OPENCHAMBER_SERVER_URL: 'https://remote.example.test/chamber', OPENCHAMBER_SKIP_LOCAL_SERVER: '1' };
    let binding;
    const state = { startupResolved: true, sidecarUrl: null, localOrigin: null, apiBaseUrl: env.OPENCHAMBER_SERVER_URL, clientToken: '', unreachableHosts: new Set(), bootOutcome: { target: 'remote', status: 'ok', hostId: '__env' } };
    await runInNewContext(`(async () => { ${reopen}; await openMainWindow(); })()`, {
      state, process: { env }, LOCAL_HOST_ID: 'local',
      readDesktopHostsConfig: () => ({ defaultHostId, hosts: [] }),
      shouldUsePackagedUi: () => true,
      buildPackagedUiUrl: () => 'openchamber-ui://app/index.html',
      resolveStoredClientTokenForUrl: () => '',
      sanitizeRuntimeRequestHeaders: (headers) => headers,
      activateMainWindow: async (url, origin, outcome, runtime) => { binding = structuredClone(runtime); },
    });
    assert.deepEqual(binding, { apiBaseUrl: env.OPENCHAMBER_SERVER_URL, clientToken: '', requestHeaders: {} });
  }
});
