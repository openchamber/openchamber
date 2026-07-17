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
    if (process.platform !== 'win32') {
      expect((await fsp.stat(settingsFilePath)).mode & 0o777).toBe(0o600);
    }
  });
});
