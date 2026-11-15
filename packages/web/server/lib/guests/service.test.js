import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  forgetServiceFailure,
  getServiceFailure,
  getServiceStatus,
  guestIdOfServiceToken,
  onGuestServiceEnded,
  beginGuestServiceHost,
  beginGuestServiceShutdown,
  proxyGuestServiceRequest,
  readServicePid,
  stopAllGuestServices,
  stopGuestService,
} from './service.js';
import { setCapabilityGrants, writeExtensionStore } from './persist.js';
import { listInstalledGuests, noteGuestPackageChanged } from './catalog.js';
import { SERVICE_TOKEN_ENV, recordGuestService } from './service-registry.js';
import { createGuestMarks } from './marks.js';

const writeFixture = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-service-'));
  const persistPath = path.join(dir, 'extensions.json');
  const packageRoot = path.join(dir, 'docker');
  await fs.mkdir(path.join(packageRoot, 'service'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'service', 'main.js'), `
import http from 'node:http';
const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
http.createServer((req, res) => {
  if (req.headers.authorization !== \`Bearer \${token}\`) {
    res.writeHead(401);
    res.end('no');
    return;
  }
  if (req.url === '/data-dir') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ dataDir: process.env.OPENCHAMBER_SERVICE_DATA_DIR }));
    return;
  }
  if (req.url === '/state-home') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stateHome: process.env.XDG_STATE_HOME, unrelated: process.env.OC_TEST_UNRELATED }));
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pong: true }));
    return;
  }
  res.writeHead(404);
  res.end('missing');
}).listen(port, '127.0.0.1');
`);
  await writeExtensionStore(persistPath, { paths: [packageRoot], sources: {}, capabilityGrants: {} });
  return { dir, persistPath, packageRoot };
};

beforeEach(() => beginGuestServiceHost());

afterEach(async () => {
  await stopAllGuestServices();
});

describe('guest service proxy', () => {
  test('passes XDG_STATE_HOME to the service without passing unrelated variables', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    const previousStateHome = process.env.XDG_STATE_HOME;
    const previousUnrelated = process.env.OC_TEST_UNRELATED;
    const stateHome = path.join(dir, 'state');
    process.env.XDG_STATE_HOME = stateHome;
    process.env.OC_TEST_UNRELATED = 'not inherited';
    try {
      const result = await proxyGuestServiceRequest({
        guestId: 'docker',
        packageRoot,
        service: { entry: 'service/main.js' },
        granted: ['service'],
        persistPath,
        method: 'GET',
        path: '/state-home',
      });
      expect(JSON.parse(result.body)).toEqual({ stateHome });
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      if (previousUnrelated === undefined) delete process.env.OC_TEST_UNRELATED;
      else process.env.OC_TEST_UNRELATED = previousUnrelated;
      await stopGuestService('docker');
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('gives the service its own data folder, created before the start', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      const result = await proxyGuestServiceRequest({
        guestId: 'docker',
        packageRoot,
        service: { entry: 'service/main.js' },
        granted: ['service'],
        persistPath,
        method: 'GET',
        path: '/data-dir',
      });
      const { dataDir } = JSON.parse(result.body);
      expect(dataDir).toBe(path.join(dir, 'guest-data', 'docker'));
      expect((await fs.stat(dataDir)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses when permissions need a grant', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await expect(proxyGuestServiceRequest({
        guestId: 'docker',
        packageRoot,
        service: {
          entry: 'service/main.js',
          permissions: { exec: ['docker'] },
        },
        granted: [],
        persistPath,
        method: 'GET',
        path: '/ping',
      })).rejects.toMatchObject({ code: 'NO_SERVICE' });
      expect(getServiceStatus('docker')).toBe('stopped');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('does not start from a folder listed from its last loaded manifest', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      const manifest = { name: 'docker', version: '1.0.0', openchamber: { apiVersion: 1, contributes: {
        panel: { id: 'docker', name: 'Docker', icon: 'window', entry: 'panel/index.html' },
        service: { entry: 'service/main.js', runtime: 'host' },
      } } };
      await fs.mkdir(path.join(packageRoot, 'panel'));
      await fs.writeFile(path.join(packageRoot, 'panel', 'index.html'), '<html></html>');
      await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
      expect((await listInstalledGuests({ persistPath })).map((guest) => guest.id)).toEqual(['docker']);

      // The new manifest does not parse yet: the row and its grant are the old ones, the files on disk are not.
      await fs.writeFile(path.join(packageRoot, 'package.json'), '{');
      noteGuestPackageChanged(persistPath, 'docker');
      const [row] = await listInstalledGuests({ persistPath });
      await expect(proxyGuestServiceRequest({
        guestId: 'docker',
        packageRoot: row.packageRoot,
        service: row.service,
        granted: ['service'],
        persistPath,
        method: 'GET',
        path: '/ping',
      })).rejects.toMatchObject({ code: 'NO_SERVICE' });
      expect(getServiceStatus('docker')).toBe('stopped');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses when the extension is disabled', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await writeExtensionStore(persistPath, {
        paths: [packageRoot],
        sources: {},
        capabilityGrants: { docker: ['service'] },
        disabledGuests: { docker: true },
      });
      await expect(proxyGuestServiceRequest({
        guestId: 'docker',
        guestName: 'Docker',
        packageRoot,
        service: {
          entry: 'service/main.js',
          permissions: { exec: ['docker'] },
        },
        granted: ['service'],
        persistPath,
        method: 'GET',
        path: '/ping',
      })).rejects.toMatchObject({
        code: 'DISABLED',
        message: 'Docker is disabled in Settings → Extensions.',
      });
      expect(getServiceStatus('docker')).toBe('stopped');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('spawns, proxies, and reports ready', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      const result = await proxyGuestServiceRequest({
        guestId: 'docker',
        packageRoot,
        service: {
          entry: 'service/main.js',
          permissions: { exec: ['docker'] },
        },
        granted: ['service'],
        persistPath,
        method: 'GET',
        path: '/ping',
      });
      expect(result).toEqual({ status: 200, body: '{"pong":true}' });
      expect(getServiceStatus('docker')).toBe('ready');
      await stopGuestService('docker');
      expect(getServiceStatus('docker')).toBe('stopped');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('keeps what a service printed when it fails to start, until a clean start', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    const entry = path.join(packageRoot, 'service', 'main.js');
    const working = await fs.readFile(entry, 'utf8');
    const request = () => proxyGuestServiceRequest({
      guestId: 'docker',
      packageRoot,
      service: { entry: 'service/main.js', permissions: { exec: ['docker'] } },
      granted: ['service'],
      persistPath,
      method: 'GET',
      path: '/ping',
    });
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      await fs.writeFile(entry, "console.error('no docker socket'); process.exit(3);");
      await expect(request()).rejects.toThrow();
      expect(getServiceFailure('docker')?.output).toContain('no docker socket');
      await fs.writeFile(entry, working);
      await request();
      expect(getServiceFailure('docker')).toBeNull();
      await stopGuestService('docker');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('keeps a service killed from outside as a failure, and forgets it on request', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    const entry = path.join(packageRoot, 'service', 'main.js');
    await fs.appendFile(entry, "\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./pid', import.meta.url), String(process.pid));\n");
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      await proxyGuestServiceRequest({
        guestId: 'docker',
        packageRoot,
        service: { entry: 'service/main.js', permissions: { exec: ['docker'] } },
        granted: ['service'],
        persistPath,
        method: 'GET',
        path: '/ping',
      });
      process.kill(Number(await fs.readFile(path.join(packageRoot, 'service', 'pid'), 'utf8')), 'SIGKILL');
      for (let tries = 0; tries < 100 && !getServiceFailure('docker'); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(getServiceFailure('docker')?.output).toContain('Stopped by SIGKILL.');
      forgetServiceFailure('docker');
      expect(getServiceFailure('docker')).toBeNull();
      await stopGuestService('docker');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('coalesces parallel first requests onto one spawn', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      const service = {
        entry: 'service/main.js',
        permissions: { exec: ['docker'] },
      };
      const results = await Promise.all([
        proxyGuestServiceRequest({
          guestId: 'docker',
          packageRoot,
          service,
          granted: ['service'],
          persistPath,
          method: 'GET',
          path: '/ping',
        }),
        proxyGuestServiceRequest({
          guestId: 'docker',
          packageRoot,
          service,
          granted: ['service'],
          persistPath,
          method: 'GET',
          path: '/ping',
        }),
        proxyGuestServiceRequest({
          guestId: 'docker',
          packageRoot,
          service,
          granted: ['service'],
          persistPath,
          method: 'GET',
          path: '/ping',
        }),
      ]);
      expect(results).toEqual([
        { status: 200, body: '{"pong":true}' },
        { status: 200, body: '{"pong":true}' },
        { status: 200, body: '{"pong":true}' },
      ]);
      expect(getServiceStatus('docker')).toBe('ready');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects a path with a scheme', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      await expect(proxyGuestServiceRequest({
        guestId: 'docker',
        packageRoot,
        service: { entry: 'service/main.js' },
        granted: ['service'],
        persistPath,
        method: 'GET',
        path: 'http://evil.example/ping',
      })).rejects.toMatchObject({ code: 'BAD_PATH' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('host-driven services', () => {
  const request = (extra) => ({
    guestId: 'docker',
    packageRoot: extra.packageRoot,
    service: { entry: 'service/main.js' },
    granted: ['service'],
    persistPath: extra.persistPath,
    method: 'GET',
    path: '/ping',
    ...extra,
  });

  test('stops itself after the idle window and restarts on the next request', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      const first = await proxyGuestServiceRequest(request({ packageRoot, persistPath, idleStopMs: 150 }));
      expect(first.status).toBe(200);
      const pid = readServicePid('docker');
      expect(pid).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(getServiceStatus('docker')).toBe('stopped');
      expect(readServicePid('docker')).toBeNull();

      const second = await proxyGuestServiceRequest(request({ packageRoot, persistPath, idleStopMs: 150 }));
      expect(second.status).toBe(200);
      expect(readServicePid('docker')).not.toBe(pid);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a request keeps re-arming the window, and a panel request never arms one', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      await proxyGuestServiceRequest(request({ packageRoot, persistPath, idleStopMs: 200 }));
      const pid = readServicePid('docker');
      for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        await proxyGuestServiceRequest(request({ packageRoot, persistPath, idleStopMs: 200 }));
      }
      expect(readServicePid('docker')).toBe(pid);

      await stopGuestService('docker');
      await proxyGuestServiceRequest(request({ packageRoot, persistPath }));
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(getServiceStatus('docker')).toBe('ready');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a longer timeout and a response cap are honoured, and an answer over the cap is refused whole', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      const result = await proxyGuestServiceRequest(request({ packageRoot, persistPath, timeoutMs: 45_000, responseMax: 1_000 }));
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toBeTruthy();
      await expect(proxyGuestServiceRequest(request({ packageRoot, persistPath, responseMax: 5 })))
        .rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
      expect(getServiceStatus('docker')).toBe('ready');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('an aborted request reports cancellation, not a failed service', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      await proxyGuestServiceRequest(request({ packageRoot, persistPath }));
      const controller = new AbortController();
      controller.abort();
      await expect(proxyGuestServiceRequest(request({ packageRoot, persistPath, signal: controller.signal })))
        .rejects.toMatchObject({ code: 'CANCELLED' });
      expect(getServiceStatus('docker')).toBe('ready');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pause during startup', () => {
  test('a stop that lands while the service is coming up wins', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      const pending = proxyGuestServiceRequest({
        guestId: 'docker',
        packageRoot,
        service: { entry: 'service/main.js', permissions: { exec: ['docker'] } },
        granted: ['service'],
        persistPath,
        method: 'GET',
        path: '/ping',
      });
      // Stop while the process is coming up: the start must notice and not
      // hand a ready service to the request that began it.
      const startedAt = Date.now();
      while (getServiceStatus('docker') !== 'starting' && Date.now() - startedAt < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(getServiceStatus('docker')).toBe('starting');
      await stopGuestService('docker');
      await expect(pending).rejects.toMatchObject({ code: 'NO_SERVICE' });
      expect(getServiceStatus('docker')).toBe('stopped');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pause before the request reads the store', () => {
  test('a stop that lands before the first read still wins', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      const pending = proxyGuestServiceRequest({
        guestId: 'docker',
        packageRoot,
        service: { entry: 'service/main.js', permissions: { exec: ['docker'] } },
        granted: ['service'],
        persistPath,
        method: 'GET',
        path: '/ping',
      });
      await stopGuestService('docker');
      await expect(pending).rejects.toMatchObject({ code: 'NO_SERVICE' });
      expect(getServiceStatus('docker')).toBe('stopped');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a service that ended', () => {
  // The fixture leaves its token beside its entry, so the test can ask who it names.
  const start = async ({ packageRoot, persistPath }) => {
    await fs.appendFile(path.join(packageRoot, 'service', 'main.js'), "\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./token', import.meta.url), token);\n");
    await setCapabilityGrants('docker', persistPath, ['service']);
    const params = {
      guestId: 'docker',
      packageRoot,
      service: { entry: 'service/main.js', permissions: { exec: ['docker'] } },
      granted: ['service'],
      persistPath,
      method: 'GET',
      path: '/ping',
    };
    await proxyGuestServiceRequest(params);
    return { params, token: await fs.readFile(path.join(packageRoot, 'service', 'token'), 'utf8') };
  };
  /** What each report found the service's token naming at that moment. */
  const listen = (token) => {
    const reports = [];
    const stop = onGuestServiceEnded((guestId) => reports.push([guestId, guestIdOfServiceToken(token)]));
    return { reports, stop };
  };

  test('a stop is reported once the token names nothing', async () => {
    const fixture = await writeFixture();
    const { token } = await start(fixture);
    const { reports, stop } = listen(token);
    const marks = createGuestMarks();
    try {
      expect(guestIdOfServiceToken(token)).toBe('docker');
      expect(marks.set('docker', token, { sessionId: 'ses_1' }, { icon: 'alert', tone: 'warning', text: 'Waiting' })).toBe('changed');
      expect(marks.list('docker')).toHaveLength(1);
      await stopGuestService('docker');
      expect(reports).toEqual([['docker', null]]);
      // What the process set is gone with it, and its token sets nothing more.
      expect(marks.dropEnded('docker')).toBe(true);
      expect(marks.list('docker')).toEqual([]);
      expect(marks.set('docker', token, { sessionId: 'ses_1' }, { icon: 'alert', tone: 'warning', text: 'Waiting' })).toBe('ended');
      // Nothing is running: a second stop ends nothing.
      await stopGuestService('docker');
      expect(reports).toHaveLength(1);
    } finally {
      stop();
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('a process killed from outside is reported, and its restart is not', async () => {
    const fixture = await writeFixture();
    const { params, token } = await start(fixture);
    const { reports, stop } = listen(token);
    try {
      process.kill(readServicePid('docker'), 'SIGKILL');
      for (let tries = 0; tries < 250 && reports.length === 0; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(reports).toEqual([['docker', null]]);
      await proxyGuestServiceRequest(params);
      const next = await fs.readFile(path.join(fixture.packageRoot, 'service', 'token'), 'utf8');
      expect(next).not.toBe(token);
      expect(guestIdOfServiceToken(next)).toBe('docker');
      // Replacing the dead process discards its runtime, which reports the same end again; nothing new ended.
      expect(reports.every(([guestId, named]) => guestId === 'docker' && named === null)).toBe(true);
    } finally {
      stop();
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('a removed listener hears nothing', async () => {
    const fixture = await writeFixture();
    const { token } = await start(fixture);
    const { reports, stop } = listen(token);
    try {
      stop();
      await stopGuestService('docker');
      expect(reports).toEqual([]);
    } finally {
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('restart after the process died', () => {
  test('the next request restarts the service instead of reading the cleanup as a pause', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      const params = {
        guestId: 'docker',
        packageRoot,
        service: { entry: 'service/main.js', permissions: { exec: ['docker'] } },
        granted: ['service'],
        persistPath,
        method: 'GET',
        path: '/ping',
      };
      expect(await proxyGuestServiceRequest(params)).toEqual({ status: 200, body: '{"pong":true}' });
      // Kill the process behind the host's back, the way a crash would.
      const pid = readServicePid('docker');
      process.kill(pid, 'SIGKILL');
      const startedAt = Date.now();
      while (getServiceStatus('docker') === 'ready' && Date.now() - startedAt < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await proxyGuestServiceRequest(params)).toEqual({ status: 200, body: '{"pong":true}' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('host shutdown', () => {
  const request = (fixture) => ({
    guestId: 'docker', packageRoot: fixture.packageRoot,
    service: { entry: 'service/main.js' }, granted: ['service'],
    persistPath: fixture.persistPath, method: 'GET', path: '/ping',
  });

  test('a replacement waits for the previous child and cannot escape host shutdown', async () => {
    const fixture = await writeFixture();
    await fs.appendFile(path.join(fixture.packageRoot, 'service/main.js'), '\nprocess.on("SIGTERM", () => {});\n');
    let pid;
    let reading;
    let accessing;
    try {
      await proxyGuestServiceRequest(request(fixture));
      pid = readServicePid('docker');
      const previousStop = stopGuestService('docker');
      accessing = spyOn(fs, 'access');
      const storeRead = Promise.withResolvers();
      const readFile = fs.readFile.bind(fs);
      reading = spyOn(fs, 'readFile').mockImplementation(async (...args) => {
        const result = await readFile(...args);
        if (args[0] === fixture.persistPath) storeRead.resolve();
        return result;
      });
      const replacement = proxyGuestServiceRequest(request(fixture)).catch((error) => error);
      await storeRead.promise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(accessing).not.toHaveBeenCalledWith(path.join(fixture.packageRoot, 'service/main.js'));
      expect(readServicePid('docker')).toBeNull();
      beginGuestServiceShutdown();
      const stopping = stopAllGuestServices();
      process.kill(pid, 'SIGKILL');
      await Promise.all([previousStop, stopping]);
      expect(await replacement).toMatchObject({ code: 'NO_SERVICE' });
      expect(readServicePid('docker')).toBeNull();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      reading?.mockRestore();
      accessing?.mockRestore();
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await stopAllGuestServices();
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('rejects new requests, drains a live child, and only reopens on a new host lifecycle', async () => {
    const fixture = await writeFixture();
    try {
      expect((await proxyGuestServiceRequest(request(fixture))).status).toBe(200);
      const pid = readServicePid('docker');
      beginGuestServiceShutdown();
      const stopping = stopAllGuestServices();
      await expect(proxyGuestServiceRequest(request(fixture))).rejects.toMatchObject({ code: 'NO_SERVICE' });
      await stopping;
      expect(readServicePid('docker')).toBeNull();
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(proxyGuestServiceRequest(request(fixture))).rejects.toMatchObject({ code: 'NO_SERVICE' });
      beginGuestServiceHost();
      expect((await proxyGuestServiceRequest(request(fixture))).status).toBe(200);
    } finally {
      await stopAllGuestServices();
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('drains a first start paused before spawn and prevents it from surviving shutdown', async () => {
    const fixture = await writeFixture();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const access = fs.access.bind(fs);
    const pausedAccess = spyOn(fs, 'access').mockImplementation(async (...args) => {
      if (args[0] === path.join(fixture.packageRoot, 'service/main.js')) {
        entered.resolve();
        await release.promise;
      }
      return access(...args);
    });
    try {
      const pending = proxyGuestServiceRequest(request(fixture)).catch((error) => error);
      await entered.promise;
      expect(readServicePid('docker')).toBeNull();
      beginGuestServiceShutdown();
      let drained = false;
      const stopping = stopAllGuestServices().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(() => beginGuestServiceHost()).toThrow();
      release.resolve();
      expect(await pending).toMatchObject({ code: 'NO_SERVICE' });
      await stopping;
      expect(readServicePid('docker')).toBeNull();
      expect(getServiceStatus('docker')).toBe('stopped');
    } finally {
      release.resolve();
      pausedAccess.mockRestore();
      await stopAllGuestServices();
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('a request still reading the store cannot enter a later host lifecycle', async () => {
    const fixture = await writeFixture();
    try {
      const pending = proxyGuestServiceRequest(request(fixture));
      beginGuestServiceShutdown();
      await stopAllGuestServices();
      beginGuestServiceHost();
      await expect(pending).rejects.toMatchObject({ code: 'NO_SERVICE' });
      expect(readServicePid('docker')).toBeNull();
    } finally {
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('crash recovery registry', () => {
  const request = (fixture) => ({
    guestId: 'docker', packageRoot: fixture.packageRoot,
    service: { entry: 'service/main.js' }, granted: ['service'],
    persistPath: fixture.persistPath, method: 'GET', path: '/ping',
  });

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test('records a running service and drops the record when it stops or dies', async () => {
    const fixture = await writeFixture();
    const registryDir = path.join(fixture.dir, 'guest-services');
    try {
      beginGuestServiceHost({ registryDir });
      expect((await proxyGuestServiceRequest(request(fixture))).status).toBe(200);
      const pid = readServicePid('docker');
      expect(await fs.readdir(registryDir)).toEqual([`${pid}.json`]);
      await stopGuestService('docker');
      expect(await fs.readdir(registryDir)).toEqual([]);

      expect((await proxyGuestServiceRequest(request(fixture))).status).toBe(200);
      const restarted = readServicePid('docker');
      expect(await fs.readdir(registryDir)).toEqual([`${restarted}.json`]);
      process.kill(restarted, 'SIGKILL');
      const startedAt = Date.now();
      while ((await fs.readdir(registryDir)).length > 0 && Date.now() - startedAt < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await fs.readdir(registryDir)).toEqual([]);
    } finally {
      await stopAllGuestServices();
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('a new host stops what a dead host left running before it spawns', async () => {
    const fixture = await writeFixture();
    const registryDir = path.join(fixture.dir, 'guest-services');
    const token = 'c'.repeat(48);
    // Slow to stop, so a spawn that did not wait for the reaper would finish first.
    const leftover = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 500));
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `], { env: { [SERVICE_TOKEN_ENV]: token }, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise((resolve) => leftover.stdout.once('data', resolve));
      const deadHost = spawn(process.execPath, ['-e', '']);
      await new Promise((resolve) => deadHost.once('exit', resolve));
      // What a host that has since died wrote when it spawned the leftover.
      await recordGuestService(registryDir, { pid: leftover.pid, guestId: 'docker', token, entry: 'service/main.js' });
      const recordPath = path.join(registryDir, `${leftover.pid}.json`);
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      await fs.writeFile(recordPath, JSON.stringify({ ...record, ownerPid: deadHost.pid }));

      beginGuestServiceHost({ registryDir });
      expect((await proxyGuestServiceRequest(request(fixture))).status).toBe(200);
      expect(alive(leftover.pid)).toBe(false);
      expect(await fs.readdir(registryDir)).toEqual([`${readServicePid('docker')}.json`]);
    } finally {
      leftover.kill('SIGKILL');
      await stopAllGuestServices();
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });
});
