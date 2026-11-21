import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installNativeElectron } from './test-support/native-electron.mjs';

const scenario = process.env.OPENCHAMBER_STARTUP_TEST;

if (!scenario) {
  for (const [name, mode] of [
    ['windows asked for during a background start wait for it and resolve nothing themselves', 'background'],
    ['a window that a foreground startup already opened is the one returned', 'foreground'],
    ['a serverless background start still probes again when the window opens', 'serverless'],
  ]) {
    test(name, () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'oc-startup-'));
      try {
        const result = spawnSync(process.execPath, [
          '--conditions=openchamber-source',
          '--import', fileURLToPath(new URL('../web/scripts/register-server-sources.mjs', import.meta.url)),
          fileURLToPath(import.meta.url),
        ], {
          env: { ...process.env, OPENCHAMBER_STARTUP_TEST: mode, OPENCHAMBER_DATA_DIR: directory },
          encoding: 'utf8',
          timeout: 15_000,
          killSignal: 'SIGKILL',
          windowsHide: true,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
} else {
  // Each launch has its own module singletons, environment and settings directory.
  const directory = process.env.OPENCHAMBER_DATA_DIR;
  process.on('unhandledRejection', (error) => {
    console.error(error);
    process.exit(1);
  });
  try {
    process.resourcesPath = directory;
    process.env.OPENCHAMBER_SKIP_LOCAL_SERVER = scenario === 'serverless' ? '1' : '0';
    process.env.OPENCHAMBER_SERVER_URL = scenario === 'serverless' ? 'https://remote.example.test' : '';
    process.env.OPENCHAMBER_ELECTRON_DEV = '1';
    process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI = '0';
    process.env.OPENCHAMBER_HMR_API_PORT = '3901';
    process.env.OPENCHAMBER_HMR_UI_PORT = '5173';
    process.env.SHELL = '/bin/nu';
    delete process.env.OPENCHAMBER_ELECTRON_USE_PACKAGED_UI;
    if (scenario !== 'foreground') process.argv.push('--background');
    writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
      desktopMiniChatGlobalShortcut: '',
      desktopQuakeModeEnabled: false,
    }));

    const ready = Promise.withResolvers();
    const probeEntered = Promise.withResolvers();
    const releaseProbe = Promise.withResolvers();
    const startupFinished = Promise.withResolvers();
    const navigated = Promise.withResolvers();
    const requests = [];
    const navigations = [];
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const appOverrides = {
      isPackaged: false,
      isReady: () => true,
      whenReady: () => ({ then: (onReady) => {
        const startup = ready.promise.then(onReady);
        startupFinished.resolve(startup);
        return startup;
      } }),
      getAppPath: () => fileURLToPath(new URL('.', import.meta.url)),
      getPath: () => directory,
      getVersion: () => '2.7.2',
      getName: () => 'OpenChamber',
      isDefaultProtocolClient: () => true,
      exit: (code) => { throw new Error(`Unexpected app exit: ${code}`); },
    };
    const fetchAtEdge = async (url) => {
      requests.push(String(url));
      if (requests.length === 1) {
        probeEntered.resolve();
        await releaseProbe.promise;
      }
      if (String(url).endsWith('/api/version')) {
        return Response.json({
          status: 'ok',
          openchamberVersion: '2.7.2',
          compatibility: { apiVersion: 1, minClientApiVersion: 1, capabilities: ['api.runtime-url.v1'] },
        });
      }
      return Response.json({ status: 'ok' });
    };
    const { app, windows } = installNativeElectron({
      directory, app: appOverrides, fetch: fetchAtEdge,
      onNavigate(window, url) {
        if (url.startsWith('http')) {
          navigations.push({ window, url });
          navigated.resolve();
        }
      },
    });

    await import('./main.mjs');
    // Request before ready so the foreground case also enters the startup wait.
    const activate = () => app.listeners('activate')[0]();
    const opens = scenario === 'foreground' ? [activate()] : [];
    ready.resolve();
    await probeEntered.promise;
    if (scenario === 'background') opens.push(activate(), activate());
    await tick();
    assert.equal(requests.length, 1, 'window requests must not start another resolution');
    assert.equal(navigations.length, 0, 'no application navigation before startup resolves');
    assert.equal(windows.length, scenario === 'foreground' ? 1 : 0);
    releaseProbe.resolve();

    if (scenario === 'serverless') {
      await startupFinished.promise;
      await tick();
      assert.equal(windows.length, 0);
      const initialProbes = requests.filter((url) => url.endsWith('/api/version')).length;
      assert.equal(initialProbes, 1);
      await activate();
      assert.equal(requests.filter((url) => url.endsWith('/api/version')).length, 2);
      await navigated.promise;
      assert.equal(navigations[0].url, 'https://remote.example.test/');
    } else {
      await Promise.all(opens);
      await navigated.promise;
      assert.equal(requests.length, 2, 'startup probes the API and UI only once each');
      assert.equal(navigations.length, 1, 'waiting requests reuse the startup result and window');
    }
    assert.equal(windows.length, 1);
    assert.equal(navigations[0].window, windows[0]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(0);
}
