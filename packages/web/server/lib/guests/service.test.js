import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getServiceStatus,
  proxyGuestServiceRequest,
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
          persistPath,
          method: 'GET',
          path: '/ping',
        }),
        proxyGuestServiceRequest({
          guestId: 'docker',
          packageRoot,
          service,
          persistPath,
          method: 'GET',
          path: '/ping',
        }),
        proxyGuestServiceRequest({
          guestId: 'docker',
          packageRoot,
          service,
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
        persistPath,
        method: 'GET',
        path: 'http://evil.example/ping',
      })).rejects.toMatchObject({ code: 'BAD_PATH' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
