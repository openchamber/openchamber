import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

import { inspectGuestPackage } from '../catalog.js';
import { effectiveGrants, guestGrantScope } from '../grant-scope.js';
import { readExtensionStore, setCapabilityGrants } from '../persist.js';
import { configureGuestOpenCodeProvider, guestIdOfServiceToken, proxyGuestServiceRequest, stopAllGuestServices, stopGuestService } from '../service.js';
import { createGuestOpenCodeProvider } from './index.js';

const cleanups = [];
afterEach(async () => {
  await stopAllGuestServices();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('a service receives a native connection for its process lifetime, approval survives reload, and stop revokes it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-opencode-provider-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'service.mjs'), `
import http from 'node:http';
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) return res.writeHead(401).end();
  if (req.url === '/health') return res.end('{}');
  if (req.url === '/connection') return res.end(JSON.stringify({ url: process.env.OPENCHAMBER_OPENCODE_URL, callback: process.env.OPENCHAMBER_HOST_CALLBACK_URL, token }));
  const answer = await fetch(process.env.OPENCHAMBER_OPENCODE_URL + '/api/session', { headers: { authorization: 'Bearer ' + token } });
  res.writeHead(answer.status).end(await answer.text());
}).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), '127.0.0.1');
`);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', openchamber: { apiVersion: 1, contributes: {
    panel: { id: 'reader', name: 'Reader', icon: 'window' },
    service: { entry: 'service.mjs', runtime: 'host', provides: ['opencode'] },
  } } }));
  const parsed = await inspectGuestPackage(dir);
  expect(parsed.ok).toBe(true);
  const guest = parsed.guest;
  const persistPath = path.join(dir, 'extensions.json');
  const scope = guestGrantScope(guest);
  await setCapabilityGrants('reader', persistPath, ['service', 'opencode'], scope);
  const reloaded = await readExtensionStore(persistPath);
  const granted = effectiveGrants(reloaded.capabilityGrants.reader, reloaded.capabilityScopes.reader, scope);
  expect(granted).toEqual(['service', 'opencode']);
  const server = http.createServer((_req, res) => res.end('{"data":[]}'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const provider = createGuestOpenCodeProvider({
    currentGuest: async () => ({ ...guest, capabilityGrants: granted }),
    buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${server.address().port}${requestPath}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic upstream-only' }),
  });
  configureGuestOpenCodeProvider(provider);
  const request = (requestPath) => proxyGuestServiceRequest({
    guestId: 'reader', packageRoot: dir, service: guest.service, granted, persistPath, method: 'GET', path: requestPath,
  });
  const connection = JSON.parse((await request('/connection')).body);
  expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(connection.token).not.toBe('upstream-only');
  expect(connection.callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(guestIdOfServiceToken(connection.token)).toBe('reader');
  // Ending a panel call leaves the approved process connection usable.
  expect((await fetch(`${connection.url}/api/session`, { headers: { Authorization: `Bearer ${connection.token}` } })).status).toBe(200);
  expect((await request('/query')).status).toBe(200);
  await stopGuestService('reader');
  expect(guestIdOfServiceToken(connection.token)).toBeNull();
  expect((await fetch(`${connection.url}/api/session`, { headers: { Authorization: `Bearer ${connection.token}` } })).status).toBe(403);
});
