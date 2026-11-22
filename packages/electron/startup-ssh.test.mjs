import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

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

test('native windows retain a failed SSH startup fallback without changing serverless environment targets', () => {
  for (const bundled of [false, true]) {
    for (const scenario of ['fallback', 'remote', 'environment']) {
      const result = spawnSync(process.execPath, [
        '--import', new URL('../web/scripts/register-server-sources.mjs', import.meta.url).href,
        '--conditions=openchamber-source', '--input-type=module',
        '--eval', `await (${runNativeWindowScenario.toString()})(${JSON.stringify({ bundled, scenario, mainUrl: new URL('./main.mjs', import.meta.url).href, edgeUrl: new URL('./test-support/native-electron.mjs', import.meta.url).href })})`,
      ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      assert.equal(result.status, 0, `${scenario}, bundled=${bundled}\n${result.stdout}\n${result.stderr}`);
    }
  }
});

async function runNativeWindowScenario({ bundled, scenario, mainUrl, edgeUrl }) {
  const { default: assert } = await import('node:assert/strict');
  const { installNativeElectron } = await import(edgeUrl);
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'startup-ssh-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const host = { id: 'ssh-1', label: 'SSH', url: 'http://127.0.0.1:43001/', clientToken: 'fixture-ssh', requestHeaders: { 'X-Fixture-Ssh': 'remote' } };
  const settings = { desktopDefaultHostId: scenario === 'environment' ? 'local' : host.id, desktopHosts: [host], desktopSshInstances: scenario === 'fallback' ? [{ id: host.id }] : [], desktopLocalClientToken: 'fixture-local' };
  process.env.OPENCHAMBER_DATA_DIR = dir;
  process.resourcesPath = dir;
  process.env.OPENCHAMBER_ELECTRON_DEV = '1';
  process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI = '0';
  process.env.OPENCHAMBER_HMR_API_PORT = '3901';
  process.env.OPENCHAMBER_HMR_UI_PORT = '5173';
  process.env.SHELL = '/bin/false';
  process.env.OPENCHAMBER_SKIP_LOCAL_SERVER = scenario === 'environment' ? '1' : '0';
  process.env.OPENCHAMBER_SERVER_URL = scenario === 'environment' ? 'https://remote.example.test/chamber' : '';
  writeFileSync(`${dir}/settings.json`, JSON.stringify(settings));
  const ready = Promise.withResolvers();
  const fetch = async () => new Response(JSON.stringify({ capabilities: ['api.runtime-url.v1'], openchamberVersion: '2.7.2' }), { headers: { 'content-type': 'application/json' } });
  const { app, windows, handlers } = installNativeElectron({
    directory: dir, fetch, app: { whenReady: () => ready.promise },
  });
  const runtimeOf = (window) => {
    const args = new Map(window.options.webPreferences.additionalArguments.map((arg) => {
      const separator = arg.indexOf('=');
      return [arg.slice(0, separator), arg.slice(separator + 1)];
    }));
    return {
      apiBaseUrl: args.get('--openchamber-api-base-url'),
      clientToken: args.get('--openchamber-client-token'),
      requestHeaders: JSON.parse(args.get('--openchamber-runtime-headers')),
    };
  };
  const reopen = async () => {
    const count = windows.length;
    for (const w of windows) w.destroyed = true;
    await Promise.all(app.listeners('activate').map((listener) => listener()));
    assert.equal(windows.length, count + 1);
    return windows.at(-1);
  };
  const newWindow = async (window) => {
    const count = windows.length;
    await handlers.get('openchamber:invoke')({ sender: window.webContents }, 'desktop_new_window');
    assert.equal(windows.length, count + 1);
    return windows.at(-1);
  };
  try {
    await import(mainUrl);
    ready.resolve();
    // Activation joins startup, then a second activation opens a fresh window.
    await Promise.all(app.listeners('activate').map((listener) => listener()));
    assert.ok(windows[0]?.url);
    process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI = bundled ? '1' : '0';
    const reopened = await reopen();
    const expected = scenario === 'fallback'
      ? { apiBaseUrl: 'http://127.0.0.1:3901', clientToken: 'fixture-local', requestHeaders: {} }
      : scenario === 'remote'
        ? { apiBaseUrl: host.url, clientToken: host.clientToken, requestHeaders: host.requestHeaders }
        : { apiBaseUrl: 'https://remote.example.test/chamber', clientToken: '', requestHeaders: {} };
    assert.deepEqual(runtimeOf(reopened), expected);
    if (scenario !== 'environment' || bundled) {
      assert.equal(reopened.url, bundled ? 'openchamber-ui://app/index.html' : expected.apiBaseUrl);
    }
    if (scenario !== 'environment') {
      const additional = await newWindow(reopened);
      assert.deepEqual(runtimeOf(additional), expected);
      assert.equal(additional.url, reopened.url);
    }
    if (scenario === 'fallback') {
      // A different default must remain selectable after the failed SSH boot.
      settings.desktopDefaultHostId = 'another-host';
      const otherHost = { id: 'another-host', label: 'Other', url: 'https://other.example.test/', clientToken: 'fixture-other', requestHeaders: { 'X-Fixture-Other': 'other' } };
      settings.desktopHosts.push(otherHost);
      writeFileSync(`${dir}/settings.json`, JSON.stringify(settings));
      const remote = await reopen();
      const remoteRuntime = { apiBaseUrl: otherHost.url, clientToken: otherHost.clientToken, requestHeaders: otherHost.requestHeaders };
      assert.deepEqual(runtimeOf(remote), remoteRuntime);
      assert.equal(remote.url, bundled ? 'openchamber-ui://app/index.html' : otherHost.url);
      const additional = await newWindow(remote);
      assert.deepEqual(runtimeOf(additional), remoteRuntime);
      assert.equal(additional.url, remote.url);
    } else if (scenario === 'environment') {
      settings.desktopDefaultHostId = null;
      writeFileSync(`${dir}/settings.json`, JSON.stringify(settings));
      assert.deepEqual(runtimeOf(await reopen()), expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
