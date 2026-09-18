import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';

import { ElectronSshManager } from './ssh-manager.mjs';

// Mirrors managedServerConfigTag() in ssh-manager.mjs.
const configTagFor = (password, bindHost = '127.0.0.1') =>
  createHash('sha256').update(`${password ?? ''}\n${bindHost}`).digest('hex').slice(0, 24);

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
  for (const scenario of ['explicit XDG with spaces', 'unset XDG', 'missing XDG with home fallback']) {
    test.skipIf(process.platform === 'win32')(`executes remote discovery, install and launch with ${scenario}`, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber ssh paths-'));
      tempDirs.push(home);
      const xdg = path.join(home, 'cache directory');
      const cache = scenario === 'unset XDG' ? path.join(home, '.cache') : xdg;
      const bin = scenario === 'missing XDG with home fallback'
        ? path.join(home, '.bun', 'bin')
        : path.join(cache, '.bun', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const executable = (file, script) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      };
      executable(path.join(bin, 'bun'), 'printf "%s\\n" "$@" > "$HOME/install-args"');
      executable(path.join(bin, 'opencode'), 'printf "1.2.3\\n"');
      executable(path.join(bin, 'openchamber'), `
if [ "$1" = "--version" ]; then printf '1.2.3\\n'; exit 0; fi
printf '%s' "$PATH" > "$HOME/launch-path"
printf '%s' "$OPENCODE_BINARY" > "$HOME/launch-opencode"
printf '4321\\n'`);
      // An earlier candidate with a different version must not win discovery.
      executable(path.join(home, '.openchamber', 'npm-global', 'bin', 'openchamber'), 'printf "0.9.0\\n"');
      const tools = path.join(home, 'tools');
      executable(path.join(tools, 'npm'), 'exit 88');
      const env = { HOME: home, PATH: `${tools}:/usr/bin:/bin` };
      if (scenario !== 'unset XDG') env.XDG_CACHE_HOME = xdg;
      const manager = new ElectronSshManager({
        settingsFilePath: path.join(home, 'settings.json'),
        appVersion: '1.2.3',
        emit: () => undefined,
      });
      manager.runRemoteCommand = async (_parsed, _controlPath, script) =>
        execFileSync('/bin/sh', ['-c', script], { env, encoding: 'utf8', timeout: 5000 });
      manager.remoteServerRunning = async () => true;
      const parsed = { destination: 'user@example.test', args: [] };

      await manager.installOpenChamberManaged(parsed, '/unused.sock', '1.2.3', 'auto');
      expect(fs.readFileSync(path.join(home, 'install-args'), 'utf8')).toBe('add\n-g\n@openchamber/web@1.2.3\n');
      const result = await manager.ensureRemoteServer({
        id: 'ssh-paths', auth: {}, remoteOpenchamber: { mode: 'managed', installMethod: 'auto' },
      }, parsed, '/unused.sock');
      expect(result.remoteBinPath).toBe(path.join(bin, 'openchamber'));
      expect(result.remotePort).toBe(4321);
      expect(fs.readFileSync(path.join(home, 'launch-opencode'), 'utf8')).toBe(path.join(bin, 'opencode'));
      const launchPath = fs.readFileSync(path.join(home, 'launch-path'), 'utf8').split(':');
      expect(launchPath).toContain(path.join(cache, '.bun', 'bin'));
      expect(launchPath).toContain(path.join(home, '.bun', 'bin'));
    });
  }

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
  test('installs OpenChamber into a home-owned npm prefix instead of the root-owned global one', async () => {
    const commands = [];
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.resolveRemoteTool = async (_parsed, _controlPath, name) => (name === 'npm' ? '/usr/bin/npm' : null);
    manager.runRemoteCommand = async (_parsed, _controlPath, script) => {
      commands.push(script);
      return '';
    };

    await manager.installOpenChamberManaged({ destination: 'user@example.test', args: [] }, '/tmp/control.sock', '1.2.3', 'auto');

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('--prefix "$HOME/.openchamber/npm-global"');
    expect(commands[0]).not.toMatch(/npm install -g @openchamber/);
  });

  test('lists every remote OpenChamber binary with its reported version', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => [
      '/home/pi/.openchamber/npm-global/bin/openchamber\t1.2.3',
      '/usr/bin/openchamber\t0.9.0',
      '',
    ].join('\n');

    const candidates = await manager.remoteOpenChamberCandidates({ destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(candidates).toEqual([
      { binPath: '/home/pi/.openchamber/npm-global/bin/openchamber', version: '1.2.3' },
      { binPath: '/usr/bin/openchamber', version: '0.9.0' },
    ]);
  });

  test('starts the resolved OpenChamber binary rather than whatever PATH exposes', async () => {
    let started = '';
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.resolveRemoteTool = async () => '/home/pi/.opencode/bin/opencode';
    manager.runRemoteCommand = async (_parsed, _controlPath, script) => {
      started = script;
      return '4321\n';
    };

    const instance = { id: 'ssh-1', auth: {}, remoteOpenchamber: { mode: 'managed' } };
    const port = await manager.startRemoteServerManaged(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      instance,
      4321,
      '/home/pi/.openchamber/npm-global/bin/openchamber',
    );

    expect(port).toBe(4321);
    expect(started).toContain("'/home/pi/.openchamber/npm-global/bin/openchamber' serve");
    expect(started).toContain("OPENCODE_BINARY='/home/pi/.opencode/bin/opencode'");
    expect(started).toContain('$HOME/.opencode/bin:');
  });

  test('refuses to start when the remote machine has no opencode CLI', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.resolveRemoteTool = async () => null;
    manager.runRemoteCommand = async () => {
      throw new Error('should not start the server without a CLI');
    };

    await expect(manager.startRemoteServerManaged(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      { id: 'ssh-1', auth: {}, remoteOpenchamber: { mode: 'managed' } },
      4321,
      '/home/pi/.bun/bin/openchamber',
    )).rejects.toThrow(/opencode CLI is not installed/);
  });
  test('prefers a bun that only exists in the home directory over npm', async () => {
    const commands = [];
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    // A login shell over SSH does not put ~/.bun/bin on PATH.
    manager.resolveRemoteTool = async (_parsed, _controlPath, name) =>
      (name === 'bun' ? '/home/pi/.bun/bin/bun' : '/usr/bin/npm');
    manager.runRemoteCommand = async (_parsed, _controlPath, script) => {
      commands.push(script);
      return '';
    };

    await manager.installOpenChamberManaged({ destination: 'user@example.test', args: [] }, '/tmp/control.sock', '1.2.3', 'auto');

    expect(commands).toEqual(["'/home/pi/.bun/bin/bun' add -g @openchamber/web@1.2.3"]);
  });
  test('stops a remote server it started through the CLI, not the authenticated HTTP route', async () => {
    const scripts = [];
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async (_parsed, _controlPath, script) => {
      scripts.push(script);
      return '';
    };

    await manager.stopRemoteServerBestEffort(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      41777,
      '/home/pi/.bun/bin/openchamber',
    );

    expect(scripts).toEqual(["'/home/pi/.bun/bin/openchamber' stop --port 41777"]);
  });
  test('publishes the remote server to its network only with a UI password', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.resolveRemoteTool = async () => '/home/pi/.opencode/bin/opencode';
    let started = '';
    manager.runRemoteCommand = async (_parsed, _controlPath, script) => {
      started = script;
      return '4321\n';
    };

    const parsed = { destination: 'user@example.test', args: [] };
    const exposed = {
      id: 'ssh-1',
      auth: {},
      remoteOpenchamber: { mode: 'managed', bindHost: '0.0.0.0' },
    };

    await expect(manager.startRemoteServerManaged(parsed, '/tmp/control.sock', exposed, 4321, '/bin/openchamber'))
      .rejects.toThrow(/requires a UI password/);

    const secured = {
      ...exposed,
      auth: { openchamberPassword: { enabled: true, value: 'remote-secret', store: 'settings' } },
    };
    await manager.startRemoteServerManaged(parsed, '/tmp/control.sock', secured, 4321, '/bin/openchamber');
    expect(started).toContain('--hostname 0.0.0.0');
  });

  const MANAGED_BIN_PATH = '/home/pi/.openchamber/npm-global/bin/openchamber';

  const createManagedServerManager = ({ appVersion = '1.2.3', portStates = {}, managedPorts, managedServerStopWaitMs } = {}) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-managed-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    if (managedPorts) {
      fs.writeFileSync(settingsFilePath, JSON.stringify({ desktopSshManagedServers: managedPorts }));
    }
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion,
      emit: () => undefined,
      managedServerStopWaitMs,
    });
    const calls = { probes: [], starts: [], stops: [] };
    manager.remoteOpenChamberCandidates = async () => [{ binPath: MANAGED_BIN_PATH, version: appVersion }];
    manager.probeRemoteSystemInfo = async (_parsed, _controlPath, port) => {
      calls.probes.push(port);
      const state = portStates[port];
      if (!state?.alive) throw new Error(`nothing answers on port ${port}`);
      return state.version ? { openchamberVersion: state.version } : {};
    };
    manager.startRemoteServerManaged = async (_parsed, _controlPath, _instance, desiredPort) => {
      calls.starts.push(desiredPort);
      portStates[desiredPort] = { alive: true, version: appVersion };
      return desiredPort;
    };
    manager.stopRemoteServerBestEffort = async (_parsed, _controlPath, port, binPath) => {
      calls.stops.push({ port, binPath });
      if (portStates[port]) portStates[port].alive = false;
    };
    return { manager, settingsFilePath, calls };
  };

  const managedInstance = (remoteOpenchamber = {}, auth = {}) => ({
    id: 'ssh-1',
    auth,
    remoteOpenchamber: { mode: 'managed', ...remoteOpenchamber },
  });

  test('adopts a daemon answering on the persisted managed port without restarting it', async () => {
    const { manager, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: '1.2.3' } },
      managedPorts: { 'ssh-1': { port: 4500 } },
    });

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result).toEqual({ remotePort: 4500, startedByUs: true, remoteBinPath: MANAGED_BIN_PATH });
    // Candidate probe plus the final reachability check on the reused port.
    expect(calls.probes).toEqual([4500, 4500]);
    expect(calls.starts).toEqual([]);
    expect(calls.stops).toEqual([]);
  });

  test('reuses a preferred-port daemon untouched and never adopts it', async () => {
    const { manager, calls } = createManagedServerManager({
      portStates: { 4600: { alive: true, version: '1.0.0-other' }, 4500: { alive: true, version: '1.2.3' } },
      managedPorts: { 'ssh-1': { port: 4500 } },
    });

    const result = await manager.ensureRemoteServer(
      managedInstance({ preferredPort: 4600 }),
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
    );

    expect(result).toEqual({ remotePort: 4600, startedByUs: false, remoteBinPath: MANAGED_BIN_PATH });
    expect(calls.probes).toEqual([4600, 4600]);
    expect(calls.starts).toEqual([]);
    expect(calls.stops).toEqual([]);
  });

  test('probes the preferred port before the persisted port', async () => {
    const { manager, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: '1.2.3' } },
      managedPorts: { 'ssh-1': { port: 4500 } },
    });

    const result = await manager.ensureRemoteServer(
      managedInstance({ preferredPort: 4600 }),
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
    );

    expect(result.remotePort).toBe(4500);
    expect(result.startedByUs).toBe(true);
    expect(calls.probes).toEqual([4600, 4500, 4500]);
  });

  test('treats a persisted port identical to the preferred port as user-pinned', async () => {
    const { manager, calls } = createManagedServerManager({
      portStates: { 4600: { alive: true, version: '1.0.0-other' } },
      managedPorts: { 'ssh-1': { port: 4600 } },
    });

    const result = await manager.ensureRemoteServer(
      managedInstance({ preferredPort: 4600 }),
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
    );

    expect(result).toEqual({ remotePort: 4600, startedByUs: false, remoteBinPath: MANAGED_BIN_PATH });
    expect(calls.probes).toEqual([4600, 4600]);
    expect(calls.stops).toEqual([]);
  });

  test('restarts a stale adopted daemon and persists the replacement port', async () => {
    const { manager, settingsFilePath, calls } = createManagedServerManager({
      appVersion: '1.2.3',
      portStates: { 4500: { alive: true, version: '1.2.2' } },
      managedPorts: { 'ssh-1': { port: 4500 } },
    });

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result.startedByUs).toBe(true);
    expect(result.remotePort).not.toBe(4500);
    expect(calls.stops).toEqual([{ port: 4500, binPath: MANAGED_BIN_PATH }]);
    expect(calls.starts).toEqual([result.remotePort]);
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopSshManagedServers['ssh-1'].port).toBe(result.remotePort);
  });

  test('restarts an adopted daemon that reports a newer version', async () => {
    const { manager, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: '9.9.9' } },
      managedPorts: { 'ssh-1': { port: 4500 } },
    });

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result.startedByUs).toBe(true);
    expect(result.remotePort).not.toBe(4500);
    expect(calls.stops).toEqual([{ port: 4500, binPath: MANAGED_BIN_PATH }]);
    expect(calls.starts).toEqual([result.remotePort]);
  });

  test('never restarts a daemon that cannot report its version', async () => {
    const { manager, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: 'unknown' } },
      managedPorts: { 'ssh-1': { port: 4500 } },
    });

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result).toEqual({ remotePort: 4500, startedByUs: true, remoteBinPath: MANAGED_BIN_PATH });
    expect(calls.stops).toEqual([]);
    expect(calls.starts).toEqual([]);
  });

  test('still starts fresh when a stale daemon refuses to stop', async () => {
    const { manager, settingsFilePath, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: '1.2.2' } },
      managedPorts: { 'ssh-1': { port: 4500 } },
      managedServerStopWaitMs: 50,
    });
    // The daemon survives the stop command: the bounded wait expires and the
    // replacement starts on a fresh port instead of failing the connect.
    manager.stopRemoteServerBestEffort = async (_parsed, _controlPath, port, binPath) => {
      calls.stops.push({ port, binPath });
    };

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result.startedByUs).toBe(true);
    expect(result.remotePort).not.toBe(4500);
    expect(calls.stops).toEqual([{ port: 4500, binPath: MANAGED_BIN_PATH }]);
    expect(calls.starts).toEqual([result.remotePort]);
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopSshManagedServers['ssh-1'].port).toBe(result.remotePort);
  });

  test('treats an auth-rejected probe on the persisted port as not running and starts fresh', async () => {
    // Known limitation: the still-running old daemon loses its persisted
    // tracking entry here, so nothing will adopt or stop it later. Distinguish
    // 401/403 from connection-refused in a follow-up.
    const { manager, settingsFilePath, calls } = createManagedServerManager({
      managedPorts: { 'ssh-1': { port: 4500 } },
    });
    manager.probeRemoteSystemInfo = async (_parsed, _controlPath, port) => {
      calls.probes.push(port);
      if (port === 4500) {
        throw new Error('Remote OpenChamber requires UI authentication and configured password was rejected (auth status 401)');
      }
      return { openchamberVersion: '1.2.3' };
    };

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result.startedByUs).toBe(true);
    expect(result.remotePort).not.toBe(4500);
    expect(calls.probes).toEqual([4500, result.remotePort]);
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopSshManagedServers['ssh-1'].port).toBe(result.remotePort);
  });

  test('starts and persists a server on the first connect without any persisted port', async () => {
    const { manager, settingsFilePath, calls } = createManagedServerManager();

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result.startedByUs).toBe(true);
    expect(calls.starts).toEqual([result.remotePort]);
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopSshManagedServers['ssh-1'].port).toBe(result.remotePort);
  });

  test('ignores malformed managed server entries', async () => {
    const { manager } = createManagedServerManager({
      managedPorts: {
        'ssh-zero': { port: 0 },
        'ssh-string': { port: 'abc' },
        'ssh-bare': 'nope',
        'ssh-valid': { port: 4500 },
      },
    });

    expect(manager.readManagedServerPort('ssh-zero')).toBeNull();
    expect(manager.readManagedServerPort('ssh-string')).toBeNull();
    expect(manager.readManagedServerPort('ssh-bare')).toBeNull();
    expect(manager.readManagedServerPort('ssh-missing')).toBeNull();
    expect(manager.readManagedServerPort('ssh-valid')).toBe(4500);
  });

  test('starts and persists a fresh server when the persisted port is dead', async () => {
    const { manager, settingsFilePath, calls } = createManagedServerManager({
      managedPorts: { 'ssh-1': { port: 4500 } },
    });

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result.startedByUs).toBe(true);
    expect(calls.probes).toEqual([4500, result.remotePort]);
    expect(calls.starts).toEqual([result.remotePort]);
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopSshManagedServers['ssh-1'].port).toBe(result.remotePort);
    expect(Number.isFinite(settings.desktopSshManagedServers['ssh-1'].updatedAtMs)).toBe(true);
  });

  test('reuses an adopted daemon whose version is unknown instead of restarting blind', async () => {
    const { manager, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: null } },
      managedPorts: { 'ssh-1': { port: 4500 } },
    });

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result).toEqual({ remotePort: 4500, startedByUs: true, remoteBinPath: MANAGED_BIN_PATH });
    expect(calls.probes).toEqual([4500, 4500]);
    expect(calls.stops).toEqual([]);
    expect(calls.starts).toEqual([]);
  });

  test('restarts an adopted daemon when the UI password changes', async () => {
    // Without the tag comparison this deadlocks: the probe succeeds against
    // the public /api/system/info, the old-password daemon is adopted, and the
    // client token request then 401s on every connect.
    const { manager, settingsFilePath, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: '1.2.3' } },
      managedPorts: { 'ssh-1': { port: 4500, configTag: configTagFor('old-secret') } },
    });

    const instance = managedInstance({}, { openchamberPassword: { enabled: true, value: 'new-secret', store: 'settings' } });
    const result = await manager.ensureRemoteServer(instance, { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result.startedByUs).toBe(true);
    expect(result.remotePort).not.toBe(4500);
    expect(calls.stops).toEqual([{ port: 4500, binPath: MANAGED_BIN_PATH }]);
    expect(calls.starts).toEqual([result.remotePort]);
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopSshManagedServers['ssh-1'].port).toBe(result.remotePort);
    expect(settings.desktopSshManagedServers['ssh-1'].configTag).toBe(configTagFor('new-secret'));
  });

  test('reuses an adopted daemon whose config tag matches', async () => {
    const { manager, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: '1.2.3' } },
      managedPorts: { 'ssh-1': { port: 4500, configTag: configTagFor(null) } },
    });

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result).toEqual({ remotePort: 4500, startedByUs: true, remoteBinPath: MANAGED_BIN_PATH });
    expect(calls.probes).toEqual([4500, 4500]);
    expect(calls.stops).toEqual([]);
    expect(calls.starts).toEqual([]);
  });

  test('restarts an adopted daemon when the bind host changes', async () => {
    const { manager, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: '1.2.3' } },
      managedPorts: { 'ssh-1': { port: 4500, configTag: configTagFor(null) } },
    });

    const instance = managedInstance(
      { bindHost: '0.0.0.0' },
      { openchamberPassword: { enabled: true, value: 'lan-secret', store: 'settings' } },
    );
    const result = await manager.ensureRemoteServer(instance, { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result.startedByUs).toBe(true);
    expect(result.remotePort).not.toBe(4500);
    expect(calls.stops).toEqual([{ port: 4500, binPath: MANAGED_BIN_PATH }]);
    expect(calls.starts).toEqual([result.remotePort]);
  });

  test('adopts a daemon whose entry predates config tags and backfills the tag', async () => {
    const { manager, settingsFilePath, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: '1.2.3' } },
      managedPorts: { 'ssh-1': { port: 4500 } },
    });

    const result = await manager.ensureRemoteServer(managedInstance(), { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result).toEqual({ remotePort: 4500, startedByUs: true, remoteBinPath: MANAGED_BIN_PATH });
    expect(calls.stops).toEqual([]);
    expect(calls.starts).toEqual([]);
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopSshManagedServers['ssh-1'].port).toBe(4500);
    expect(settings.desktopSshManagedServers['ssh-1'].configTag).toBe(configTagFor(null));
  });

  test('restarts an adopted daemon whose version cannot be reported once its config tag changes', async () => {
    // The 'unknown' version guard suppresses version restarts only; a config
    // edit still forces a restart so the change takes effect.
    const { manager, calls } = createManagedServerManager({
      portStates: { 4500: { alive: true, version: 'unknown' } },
      managedPorts: { 'ssh-1': { port: 4500, configTag: configTagFor(null) } },
    });

    const instance = managedInstance({}, { openchamberPassword: { enabled: true, value: 'new-secret', store: 'settings' } });
    const result = await manager.ensureRemoteServer(instance, { destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(result.startedByUs).toBe(true);
    expect(result.remotePort).not.toBe(4500);
    expect(calls.stops).toEqual([{ port: 4500, binPath: MANAGED_BIN_PATH }]);
    expect(calls.starts).toEqual([result.remotePort]);
  });

  test('prunes managed server ports of deleted instances on setInstances', async () => {
    const { manager, settingsFilePath } = createManagedServerManager({
      managedPorts: {
        'ssh-keep': { port: 4500, updatedAtMs: 1 },
        'ssh-gone': { port: 4600, updatedAtMs: 1 },
      },
    });

    await manager.setInstances({ instances: [{ id: 'ssh-keep', sshCommand: 'ssh host' }] });

    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopSshManagedServers).toEqual({ 'ssh-keep': { port: 4500, updatedAtMs: 1 } });
    expect(manager.readManagedServerPort('ssh-keep')).toBe(4500);
    expect(manager.readManagedServerPort('ssh-gone')).toBeNull();
  });
});
