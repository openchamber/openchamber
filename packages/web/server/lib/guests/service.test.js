import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getServiceStatus,
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
