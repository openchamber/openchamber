import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { ElectronSshManager } from './ssh-manager.mjs';

const servers = [];
const tempDirs = [];

const createChild = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    return true;
  };
  return child;
};

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
  test('runs Windows SSH commands without ControlMaster and hides the process window', async () => {
    const calls = [];
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'win32',
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        const child = createChild();
        queueMicrotask(() => {
          child.stdout.end('Linux\n');
          child.exitCode = 0;
          child.emit('close', 0);
        });
        return child;
      },
    });
    const parsed = { destination: 'user@example.test', args: [] };

    await expect(manager.runRemoteCommand(parsed, 'C:\\Temp\\unused.sock', 'uname -s')).resolves.toBe('Linux\n');

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('ssh');
    expect(calls[0].options.windowsHide).toBe(true);
    expect(calls[0].args).toContain('ControlMaster=no');
    expect(calls[0].args).toContain('ControlPath=none');
    expect(calls[0].args).toContain('StrictHostKeyChecking=accept-new');
    expect(calls[0].args).not.toContain('ControlPath=C:\\Temp\\unused.sock');
  });

  test('creates a PowerShell-backed askpass helper on Windows', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-askpass-test-'));
    tempDirs.push(tempDir);
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(tempDir, 'settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'win32',
    });

    const result = await manager.writeAskpassFiles(tempDir);

    expect(path.basename(result.askpassPath)).toBe('askpass.cmd');
    expect(result.cleanupPaths.map((filePath) => path.basename(filePath))).toEqual(['askpass.cmd', 'askpass.ps1']);
    expect(await fsp.readFile(path.join(tempDir, 'askpass.cmd'), 'utf8')).toContain('WindowsPowerShell');
    expect(await fsp.readFile(path.join(tempDir, 'askpass.ps1'), 'utf8')).toContain('OPENCHAMBER_SSH_ASKPASS_VALUE');
  });

  test('runs each Windows port forward as an independent hidden SSH process', async () => {
    const calls = [];
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'win32',
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return createChild();
      },
    });
    const parsed = { destination: 'user@example.test', args: [] };
    manager.sshAuth.set(parsed, {
      askpassPath: 'C:\\OpenChamber\\askpass.cmd',
      sshPassword: 'secret-value',
      children: new Set(),
    });

    await manager.spawnMainForward(parsed, 'C:\\Temp\\unused.sock', '127.0.0.1', 3000, 4000);
    await manager.spawnExtraForward(parsed, 'C:\\Temp\\unused.sock', {
      id: 'dynamic-1',
      type: 'dynamic',
      localHost: '127.0.0.1',
      localPort: 5000,
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.command).toBe('ssh');
      expect(call.args).toContain('ControlPath=none');
      expect(call.args).toContain('-N');
      expect(call.options.windowsHide).toBe(true);
      expect(call.options.env.SSH_ASKPASS).toBe('C:\\OpenChamber\\askpass.cmd');
      expect(call.options.env.OPENCHAMBER_SSH_ASKPASS_VALUE).toBe('secret-value');
    }
    expect(calls[0].args).toContain('-L');
    expect(calls[1].args).toContain('-D');
  });

  test('keeps ControlMaster-backed forwarding on non-Windows platforms', async () => {
    const calls = [];
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'darwin',
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return createChild();
      },
    });
    const parsed = { destination: 'user@example.test', args: [] };

    await manager.spawnMainForward(parsed, '/tmp/control.sock', '127.0.0.1', 3000, 4000);

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('ControlPath=/tmp/control.sock');
    expect(calls[0].args).not.toContain('ControlPath=none');
    expect(calls[0].options.windowsHide).toBeUndefined();
  });

  test('stops in-flight commands and forwards when disconnecting Windows SSH', async () => {
    const killedChildren = [];
    const spawnedChildren = [];
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'win32',
      spawn: () => {
        const child = createChild();
        child.kill = () => {
          killedChildren.push(child);
          child.exitCode = 1;
          child.emit('close', 1);
          return true;
        };
        spawnedChildren.push(child);
        return child;
      },
    });
    const parsed = { destination: 'user@example.test', args: [] };
    const mainForward = createChild();
    const extraForward = createChild();
    for (const child of [mainForward, extraForward]) {
      child.kill = () => {
        killedChildren.push(child);
        child.exitCode = 0;
        return true;
      };
    }
    manager.sshAuth.set(parsed, {
      askpassPath: 'C:\\OpenChamber\\askpass.cmd',
      sshPassword: null,
      children: new Set(),
    });
    manager.sessions.set('ssh-1', {
      instance: { remoteOpenchamber: { mode: 'external', keepRunning: true } },
      parsed,
      controlPath: 'C:\\Temp\\unused.sock',
      askpassCleanupPaths: [],
      startedByUs: false,
      remotePort: null,
      master: null,
      mainForward,
      extraForwards: [{ id: 'dynamic-1', child: extraForward }],
    });

    let commandError = null;
    const command = manager.runRemoteCommand(parsed, 'C:\\Temp\\unused.sock', 'uname -s').catch((error) => {
      commandError = error;
    });
    await manager.disconnectInternal('ssh-1', false);

    await command;
    expect(commandError?.message).toBe('Remote command failed');
    expect(spawnedChildren).toHaveLength(1);
    expect(new Set(killedChildren)).toEqual(new Set([spawnedChildren[0], mainForward, extraForward]));
    expect(manager.sessions.has('ssh-1')).toBe(false);
  });

  test('reports bounded, sanitized, and redacted SSH master stderr when startup fails', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      spawn: () => {
        const child = createChild();
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit('close', 1);
        });
        return child;
      },
    });
    const parsed = { destination: 'user@example.test', args: [] };
    const master = createChild();
    manager.sshAuth.set(parsed, {
      askpassPath: '/tmp/askpass.sh',
      sshPassword: 'secret-value',
      children: new Set(),
    });
    manager.trackSshProcess(master, parsed);
    master.stderr.write(`muxclient socket failed: secret-value\u0007${'x'.repeat(3000)}`);
    master.exitCode = 255;

    try {
      await manager.waitForMasterReady(parsed, '/tmp/control.sock', 1, master);
      throw new Error('Expected SSH master startup to fail');
    } catch (error) {
      expect(error.message).toStartWith('muxclient socket failed: [redacted]');
      expect(error.message).not.toContain('secret-value');
      expect(error.message).not.toContain('\u0007');
      expect(error.message.length).toBeLessThanOrEqual(2000);
    }
  });

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
});
