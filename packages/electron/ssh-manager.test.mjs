import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ElectronSshManager } from './ssh-manager.mjs';

const servers = [];
const tempDirs = [];

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
};

const readBody = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk.toString();
  return body;
};

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ElectronSshManager', () => {
  test('stores a client token for forwarded OpenChamber hosts when UI password is configured', async () => {
    let loginPayload = null;
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/auth/session') {
        loginPayload = JSON.parse(await readBody(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: true, clientToken: 'ssh-client-token' }));
        return;
      }
      res.writeHead(404).end();
    });
    const localUrl = await listen(server);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    const token = await manager.issueClientToken(localUrl, 'ui-secret');
    await manager.updateHostRuntime('ssh-1', 'SSH Host', localUrl, token);

    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(loginPayload).toMatchObject({
      password: 'ui-secret',
      trustDevice: true,
      issueClientToken: true,
    });
    expect(settings.desktopHosts).toEqual([{ id: 'ssh-1', label: 'SSH Host', url: localUrl, apiUrl: localUrl, clientToken: 'ssh-client-token' }]);
  });

  test('[repro] setInstances preserves apiUrl after updateHostRuntime set it', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    // Step 1: Simulate creating SSH instance via setInstances (as done by IPC handler)
    await manager.setInstances({
      instances: [
        {
          id: 'ssh-test',
          nickname: 'test-host',
          sshCommand: 'ssh user@remote-host',
          connectionTimeoutSec: 30,
          remoteOpenchamber: { mode: 'managed' },
          localForward: { bindHost: '127.0.0.1' },
          portForwards: [],
        },
      ],
    });

    let settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopSshInstances).toHaveLength(1);
    expect(settings.desktopHosts).toHaveLength(1);
    expect(settings.desktopHosts[0].url).toBe('http://127.0.0.1/');
    // Initial placeholder should NOT have apiUrl (it's set later by updateHostRuntime)
    expect(settings.desktopHosts[0].apiUrl).toBeUndefined();

    // Step 2: Simulate first connection - updateHostRuntime sets url and apiUrl
    const portA = 50001;
    const localUrlA = `http://127.0.0.1:${portA}`;
    await manager.updateHostRuntime('ssh-test', 'test-host', localUrlA, 'client-token-a');

    settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopHosts).toHaveLength(1);
    expect(settings.desktopHosts[0].url).toBe(localUrlA);
    expect(settings.desktopHosts[0].apiUrl).toBe(localUrlA);
    expect(settings.desktopHosts[0].clientToken).toBe('client-token-a');

    // Step 3: Simulate user editing SSH instance config (e.g., changing nickname)
    // This calls setInstances again
    await manager.setInstances({
      instances: [
        {
          id: 'ssh-test',
          nickname: 'renamed-host',  // changed nickname
          sshCommand: 'ssh user@remote-host',
          connectionTimeoutSec: 30,
          remoteOpenchamber: { mode: 'managed' },
          localForward: { bindHost: '127.0.0.1' },
          portForwards: [],
        },
      ],
    });

    // Verify: setInstances must preserve apiUrl when it processes existing host entry
    settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopHosts).toHaveLength(1);
    expect(settings.desktopHosts[0].label).toBe('renamed-host');
    expect(settings.desktopHosts[0].url).toBe(localUrlA);  // url preserved
    expect(settings.desktopHosts[0].apiUrl).toBe(localUrlA);  // apiUrl preserved - KEY ASSERTION
    expect(settings.desktopHosts[0].clientToken).toBe('client-token-a');  // clientToken preserved

    // Step 4: Simulate SSH reconnect with a NEW port (port changed, e.g., old port taken)
    const portB = 50002;
    const localUrlB = `http://127.0.0.1:${portB}`;
    await manager.updateHostRuntime('ssh-test', 'renamed-host', localUrlB, 'client-token-b');

    // Verify: Both url and apiUrl are updated to the new port
    settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopHosts).toHaveLength(1);
    expect(settings.desktopHosts[0].url).toBe(localUrlB);
    expect(settings.desktopHosts[0].apiUrl).toBe(localUrlB);  // Both should be updated
    expect(settings.desktopHosts[0].clientToken).toBe('client-token-b');
  });

  test('[repro] race: setInstances and updateHostRuntime concurrent writes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    // Set up initial state with updateHostRuntime
    await manager.updateHostRuntime('ssh-test', 'test-host', 'http://127.0.0.1:50001', 'token-a');

    // Simulate race: setInstances reads stale data while updateHostRuntime writes
    const p1 = manager.setInstances({
      instances: [
        {
          id: 'ssh-test',
          nickname: 'race-host',
          sshCommand: 'ssh user@remote-host',
          connectionTimeoutSec: 30,
          remoteOpenchamber: { mode: 'managed' },
          localForward: { bindHost: '127.0.0.1' },
          portForwards: [],
        },
      ],
    });

    const p2 = manager.updateHostRuntime('ssh-test', 'test-host', 'http://127.0.0.1:50002', 'token-b');

    await Promise.all([p1, p2]);

    // After both writes complete, the last writer wins.
    // Both should either have the port from p2 or p1's data.
    // In no case should apiUrl be out of sync with url.
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    const host = settings.desktopHosts.find((h) => h.id === 'ssh-test');
    expect(host).toBeDefined();
    // Both url and apiUrl must be consistent (same port)
    expect(host.url).toBe(host.apiUrl);
    // url must be a valid port URL
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('[repro] setInstances does NOT strip apiUrl when creating new host entries for existing SSH hosts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    // Create host entry with apiUrl via updateHostRuntime first
    await manager.updateHostRuntime('ssh-keep', 'Keep Host', 'http://127.0.0.1:50001', 'token-keep');
    
    // Add another unrelated host entry (direct host) via writeDesktopHostsConfig
    // Simulate having both SSH and non-SSH hosts
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    
    // Now call setInstances - this should preserve the existing apiUrl
    await manager.setInstances({
      instances: [
        {
          id: 'ssh-keep',
          nickname: 'Keep Host Updated',
          sshCommand: 'ssh user@remote-host',
          connectionTimeoutSec: 30,
          remoteOpenchamber: { mode: 'managed' },
          localForward: { bindHost: '127.0.0.1' },
          portForwards: [],
        },
      ],
    });

    const finalSettings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    const host = finalSettings.desktopHosts.find((h) => h.id === 'ssh-keep');
    expect(host).toBeDefined();
    expect(host.url).toBe('http://127.0.0.1:50001');
    expect(host.apiUrl).toBe('http://127.0.0.1:50001');
    expect(host.clientToken).toBe('token-keep');
  });
});
