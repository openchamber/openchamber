import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getServiceStatus,
  beginGuestServiceHost,
  beginGuestServiceShutdown,
  proxyGuestServiceRequest,
  readServicePid,
  stopAllGuestServices,
  stopGuestService,
} from './service.js';
import { setCapabilityGrants, writeExtensionStore } from './persist.js';

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

  test('a longer timeout and a bigger response cap are honoured', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setCapabilityGrants('docker', persistPath, ['service']);
      const result = await proxyGuestServiceRequest(request({ packageRoot, persistPath, timeoutMs: 45_000, responseMax: 5 }));
      expect(result).toEqual({ status: 200, body: '{"pon' });
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
