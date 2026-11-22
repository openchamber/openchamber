import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';

import { DEFAULT_SSH_OUTPUT_TIMEOUT_MS, ElectronSshManager, MAX_SSH_OUTPUT_BYTES } from './ssh-manager.mjs';

// The remote probes call coreutils, which some hosts (NixOS) keep outside /usr/bin and /bin.
const coreutilsDir = (home) => {
  const dir = path.join(home, 'coreutils');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['head', 'sed', 'sort', 'tail', 'ls', 'dirname', 'mkdir']) {
    const source = (process.env.PATH ?? '').split(path.delimiter)
      .map((entry) => path.join(entry, name))
      .find((file) => fs.existsSync(file));
    if (source) fs.symlinkSync(source, path.join(dir, name));
  }
  return dir;
};

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
  test('bounds local diagnostic snapshots without reading any remote host', () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test', emit: () => undefined,
    });
    for (let index = 0; index < 22; index++) {
      manager.appendLog(`connection-${index}`, 'Starting SSH connection');
    }
    manager.setStatus('connection-21', 'ready', 'private host name');
    const snapshots = manager.diagnosticLogSnapshots();
    expect(snapshots.omittedSources).toBe(2);
    expect(snapshots.entries).toHaveLength(20);
    expect(snapshots.entries.at(-1).phase).toBe('ready');
    expect(snapshots.entries.at(-1)).not.toHaveProperty('detail');
  });
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
      const env = { HOME: home, PATH: `${tools}:${coreutilsDir(home)}:/usr/bin:/bin` };
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

  test('caps runRemoteCommand stdout and kills the child over the cap', async () => {
    const calls = [];
    let killed = false;
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      spawn: (command, args) => {
        calls.push({ command, args });
        const child = createChild();
        child.kill = () => {
          killed = true;
          return true;
        };
        queueMicrotask(() => {
          child.stdout.end('x'.repeat(5000));
        });
        return child;
      },
    });
    const parsed = { destination: 'user@example.test', args: [] };

    await expect(manager.runRemoteCommand(parsed, '/tmp/unused.sock', 'uname -s', 60, { maxStdoutBytes: 1024 }))
      .rejects.toThrow('output-too-large');
    expect(killed).toBe(true);
    expect(calls[0].args).toContain('ConnectTimeout=60');
  });

  test('decodes runSshOutput stdout split inside multi-byte characters exactly (#1577)', async () => {
    const text = 'café 🔑 done\n';
    const bytes = Buffer.from(text, 'utf8');
    // Byte 4 ends inside the 2-byte é (bytes 3-4); byte 8 ends inside the
    // 4-byte 🔑 (bytes 6-9). Per-chunk decoding turned both into U+FFFD.
    const chunks = [bytes.subarray(0, 4), bytes.subarray(4, 8), bytes.subarray(8)];
    const runWithChunks = async (writeChunks) => {
      const manager = new ElectronSshManager({
        settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
        appVersion: '0.0.0-test',
        emit: () => undefined,
        spawn: () => {
          const child = createChild();
          queueMicrotask(() => {
            writeChunks(child);
            child.stdout.end();
            child.exitCode = 0;
            child.emit('close', 0);
          });
          return child;
        },
      });
      const parsed = { destination: 'user@example.test', args: [] };
      return manager.runRemoteCommand(parsed, '/tmp/unused.sock', 'probe');
    };

    const control = await runWithChunks((child) => { child.stdout.write(bytes); });
    expect(control).toBe(text);

    const split = await runWithChunks((child) => { for (const chunk of chunks) child.stdout.write(chunk); });
    expect(split).toBe(text);
    expect(split).not.toContain('\uFFFD');
  });

  test('charges the runSshOutput cap on bytes received, not decoded text (#1577)', async () => {
    const bytes = Buffer.from('é', 'utf8'); // 2 bytes received
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      spawn: () => {
        const child = createChild();
        queueMicrotask(() => {
          // Split inside the character: per-chunk decoding produced two
          // U+FFFD (6 bytes of decoded text) for these same 2 bytes.
          child.stdout.write(bytes.subarray(0, 1));
          child.stdout.write(bytes.subarray(1));
          child.stdout.end();
          child.exitCode = 0;
          child.emit('close', 0);
        });
        return child;
      },
    });
    const parsed = { destination: 'user@example.test', args: [] };

    await expect(manager.runRemoteCommand(parsed, '/tmp/unused.sock', 'probe', 60, { maxStdoutBytes: 3 })).resolves.toBe('é');
  });

  test('rejects a silent runRemoteCommand child at the execution deadline', async () => {
    let killed = false;
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      spawn: () => {
        const child = createChild();
        child.kill = () => {
          killed = true;
          return true;
        };
        return child;
      },
    });
    const parsed = { destination: 'user@example.test', args: [] };

    await expect(manager.runRemoteCommand(parsed, '/tmp/unused.sock', 'uname -s', 60, { executionTimeoutMs: 50 }))
      .rejects.toThrow('timed out after 50ms');
    expect(killed).toBe(true);
  });

  test('documents the ssh output defaults', () => {
    expect(MAX_SSH_OUTPUT_BYTES).toBe(4 * 1024 * 1024);
    expect(DEFAULT_SSH_OUTPUT_TIMEOUT_MS).toBe(120 * 1000);
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

  // The fake exits like `ssh -O forward` does: stderr first, then close.
  const createControlMasterManager = ({ code, stderr = '' }) => {
    const calls = [];
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      platform: 'darwin',
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        const child = createChild();
        setImmediate(() => {
          if (stderr) child.stderr.write(stderr);
          child.exitCode = code;
          child.emit('close', code);
        });
        return child;
      },
    });
    return { calls, manager };
  };

  test('hands the main forward to the ControlMaster instead of keeping an SSH client running', async () => {
    const { calls, manager } = createControlMasterManager({ code: 0 });
    const parsed = { destination: 'user@example.test', args: [] };

    const child = await manager.spawnMainForward(parsed, '/tmp/control.sock', '127.0.0.1', 3000, 4000);

    expect(child).toBeNull();
    expect(calls).toHaveLength(1);
    const { args, options } = calls[0];
    expect(args).toContain('ControlPath=/tmp/control.sock');
    expect(args).not.toContain('ControlPath=none');
    // `-N -L` through a mux opens a remote login shell and exits with its
    // status, which is how an exit 1 was mistaken for a dead tunnel (#4132).
    expect(args).not.toContain('-N');
    expect(args.slice(args.indexOf('-O'), args.indexOf('-O') + 4)).toEqual(['-O', 'forward', '-L', '127.0.0.1:3000:127.0.0.1:4000']);
    expect(options.windowsHide).toBeUndefined();
  });

  test('fails the connection with the master\'s reason when it cannot take the main forward', async () => {
    const { manager } = createControlMasterManager({
      code: 255,
      stderr: 'mux_client_forward: forwarding request failed: Port forwarding failed\nmuxclient: master forward request failed\n',
    });
    const parsed = { destination: 'user@example.test', args: [] };

    await expect(manager.spawnMainForward(parsed, '/tmp/control.sock', '127.0.0.1', 3000, 4000))
      .rejects.toThrow('muxclient: master forward request failed');
  });

  test('keeps a master-held forward while its port answers and drops it once the master is gone', async () => {
    // Every ssh call here is `-O check`, answered as a dead master.
    const { manager } = createControlMasterManager({ code: 255 });
    const statuses = [];
    manager.emit = (_event, status) => statuses.push(status);
    manager.connect = async () => undefined;
    const liveServer = http.createServer();
    const livePort = Number(new URL(await listen(liveServer)).port);
    const deadServer = http.createServer();
    const deadPort = Number(new URL(await listen(deadServer)).port);
    await new Promise((resolve) => deadServer.close(resolve));
    servers.splice(servers.indexOf(deadServer), 1);
    for (const [id, localPort] of [['ssh-live', livePort], ['ssh-dead', deadPort]]) {
      manager.sessions.set(id, {
        instance: { id, remoteOpenchamber: { mode: 'external' } },
        parsed: { destination: 'user@example.test', args: [] },
        controlPath: '/unused.sock',
        askpassCleanupPaths: [],
        localPort,
        master: null,
        mainForward: null,
        extraForwards: [],
      });
      manager.spawnMonitor(id);
    }

    await new Promise((resolve) => setTimeout(resolve, 2600));
    for (const id of ['ssh-live', 'ssh-dead']) {
      clearTimeout(manager.monitorTimers.get(id));
    }

    expect(manager.sessions.has('ssh-live')).toBe(true);
    expect(statuses.filter((status) => status.id === 'ssh-live')).toEqual([]);
    expect(statuses.find((status) => status.id === 'ssh-dead' && status.phase === 'degraded')?.detail)
      .toBe('SSH ControlMaster is not reachable. Reconnecting');
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

  test('identifies only a ready SSH forward as a remote API', () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });
    const forwarded = 'http://127.0.0.1:54000';
    manager.setStatus('ssh-1', 'ready', null, forwarded, 54000);

    expect(manager.isForwardedApiUrl(forwarded, 'ssh-1')).toBe(true);
    expect(manager.isForwardedApiUrl(forwarded)).toBe(true);
    expect(manager.isForwardedApiUrl(forwarded, 'other-host')).toBe(false);
    expect(manager.isForwardedApiUrl('http://127.0.0.1:3901')).toBe(false);
    manager.setStatus('ssh-1', 'degraded');
    expect(manager.isForwardedApiUrl(forwarded)).toBe(false);
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
  test.skipIf(process.platform === 'win32')('finds the newest nvm npm that the SSH login shell does not have on PATH', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-nvm-'));
    const executable = (file, script) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    };
    // Numeric order, not text order: v9 sorts after v24 as text.
    for (const version of ['v9.11.2', 'v24.18.0']) {
      const bin = path.join(home, '.nvm', 'versions', 'node', version, 'bin');
      executable(path.join(bin, 'node'), 'exit 0');
      executable(path.join(bin, 'npm'), `printf '%s' "$PATH" > "$HOME/npm-path"; printf '${version}' > "$HOME/npm-version"`);
    }
    const env = { HOME: home, PATH: `${coreutilsDir(home)}:/usr/bin:/bin` };
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(home, 'settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async (_parsed, _controlPath, script) =>
      execFileSync('/bin/sh', ['-c', script], { env, encoding: 'utf8', timeout: 5000 });

    try {
      await manager.installOpenChamberManaged({ destination: 'user@example.test', args: [] }, '/unused.sock', '1.2.3', 'auto');
      expect(fs.readFileSync(path.join(home, 'npm-version'), 'utf8')).toBe('v24.18.0');
      expect(fs.readFileSync(path.join(home, 'npm-path'), 'utf8').split(':')[0])
        .toBe(path.join(home, '.nvm', 'versions', 'node', 'v24.18.0', 'bin'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('starts the managed server with an nvm-installed opencode that the SSH login shell does not have on PATH', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-nvm-opencode-'));
    tempDirs.push(home);
    const executable = (file, script) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    };
    // opencode only under nvm's node, and no nvm entry on PATH: exactly what a
    // non-interactive SSH login shell sees after `npm install -g` with nvm.
    const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v24.18.0', 'bin');
    executable(path.join(nvmBin, 'opencode'), 'exit 0');
    executable(path.join(home, '.openchamber', 'npm-global', 'bin', 'openchamber'), `
if [ "$1" = "--version" ]; then printf '1.2.3\\n'; exit 0; fi
printf '%s' "$OPENCODE_BINARY" > "$HOME/launch-opencode"
printf '4321\\n'`);
    const env = { HOME: home, PATH: `${coreutilsDir(home)}:/usr/bin:/bin` };
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(home, 'settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async (_parsed, _controlPath, script) =>
      execFileSync('/bin/sh', ['-c', script], { env, encoding: 'utf8', timeout: 5000 });
    manager.remoteServerRunning = async () => true;

    const result = await manager.ensureRemoteServer(
      { id: 'ssh-nvm-opencode', auth: {}, remoteOpenchamber: { mode: 'managed' } },
      { destination: 'user@example.test', args: [] },
      '/unused.sock',
    );

    expect(result.remotePort).toBe(4321);
    expect(fs.readFileSync(path.join(home, 'launch-opencode'), 'utf8')).toBe(path.join(nvmBin, 'opencode'));
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

  test('ignores login-shell banner lines when listing remote OpenChamber binaries', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    // The candidate script runs through a login shell (`sh -lc`): a distro
    // banner precedes its `path<TAB>version` lines and is not a binary.
    manager.runRemoteCommand = async () => [
      'Welcome to Ubuntu 24.04.3 LTS (GNU/Linux 6.8.0 x86_64)',
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

  test('resolves a remote tool to its path when login-shell banner output precedes it', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => [
      'Welcome to Ubuntu 24.04.3 LTS (GNU/Linux 6.8.0 x86_64)',
      '/home/pi/.opencode/bin/opencode',
    ].join('\n');

    const resolved = await manager.resolveRemoteTool(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      'opencode',
      ['"$HOME/.opencode/bin/opencode"'],
    );

    expect(resolved).toBe('/home/pi/.opencode/bin/opencode');
  });

  test('resolves no remote tool when only login-shell banner output comes back', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => 'Welcome to Ubuntu 24.04.3 LTS (GNU/Linux 6.8.0 x86_64)\n';

    const resolved = await manager.resolveRemoteTool(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      'opencode',
      ['"$HOME/.opencode/bin/opencode"'],
    );

    expect(resolved).toBeNull();
  });

  test('resolves no remote tool when the last banner line starts with a slash', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    // No candidate is executable, so the resolve script prints nothing and
    // the output is banner-only. The last banner line starts with '/' and
    // reads as a path with spaces; it is a sentence, not the tool path.
    manager.runRemoteCommand = async () => 'Welcome to Ubuntu\n/home/user/bin is on your PATH\n';

    const resolved = await manager.resolveRemoteTool(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      'opencode',
      ['"$HOME/.opencode/bin/opencode"'],
    );

    expect(resolved).toBeNull();
  });

  test('resolves no remote tool when a slash-led banner line has no trailing newline', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => 'Welcome to Ubuntu\n/home/user/bin is on your PATH';

    const resolved = await manager.resolveRemoteTool(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      'opencode',
      ['"$HOME/.opencode/bin/opencode"'],
    );

    expect(resolved).toBeNull();
  });

  test('resolves a remote tool whose path contains spaces when banner output precedes it', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    // The script prints its answer with no trailing newline after the
    // banner, and a remote path under a directory with spaces is genuine.
    manager.runRemoteCommand = async () => 'Welcome to Ubuntu\n/home/user/my tools/opencode';

    const resolved = await manager.resolveRemoteTool(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      'opencode',
      ['"$HOME/my tools/opencode"'],
    );

    expect(resolved).toBe('/home/user/my tools/opencode');
  });

  test('reads the remote OS from its own line when login-shell banner output precedes it', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => [
      'Welcome to Ubuntu 24.04.3 LTS (GNU/Linux 6.8.0 x86_64)',
      'Linux',
    ].join('\n');

    const remoteOs = await manager.probeRemoteOs({ destination: 'user@example.test', args: [] }, '/tmp/control.sock');

    expect(remoteOs).toBe('linux');
  });

  test('still refuses a genuinely unsupported remote OS', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => 'FreeBSD\n';

    await expect(manager.probeRemoteOs({ destination: 'user@example.test', args: [] }, '/tmp/control.sock'))
      .rejects.toThrow(/Unsupported remote OS: freebsd/);
  });

  test('finds the server registry when login-shell banner output contains a brace', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => [
      'Welcome {admin} to Ubuntu 24.04.3 LTS',
      JSON.stringify({ instances: [{ runtime: 'cli', port: 4096, launchMode: 'daemon', bindHost: '127.0.0.1' }] }),
    ].join('\n');

    const servers = await manager.listRemoteServers(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      '/home/pi/.openchamber/npm-global/bin/openchamber',
    );

    expect(servers).toEqual([{ port: 4096, launchMode: 'daemon', bindHost: '127.0.0.1', passwordProtected: null }]);
  });

  test('drops out-of-range ports from stored instances instead of forwarding them to ssh', () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    const instance = manager.sanitizeInstance({
      id: 'ssh-1',
      sshCommand: 'ssh user@example.com',
      remoteOpenchamber: { preferredPort: 99999 },
      localForward: { preferredLocalPort: -5 },
      portForwards: [
        { id: 'bad-remote', type: 'local', localPort: 8080, remotePort: 70000 },
        { id: 'bad-local', type: 'remote', localPort: -1, remotePort: 80 },
        { id: 'fractional', type: 'local', localPort: 8080.9, remotePort: 80 },
        { id: 'too-big-dynamic', type: 'dynamic', localPort: 123456 },
        { id: 'good', type: 'local', localPort: 1, remotePort: 65535 },
      ],
    });

    expect(instance.remoteOpenchamber).not.toHaveProperty('preferredPort');
    expect(instance.localForward).not.toHaveProperty('preferredLocalPort');
    expect(instance.portForwards).toEqual([
      { id: 'good', enabled: true, type: 'local', localPort: 1, remoteHost: '127.0.0.1', remotePort: 65535, localHost: '127.0.0.1' },
    ]);

    const valid = manager.sanitizeInstance({
      id: 'ssh-2',
      sshCommand: 'ssh user@example.com',
      remoteOpenchamber: { preferredPort: 4096 },
      localForward: { preferredLocalPort: 65535 },
    });
    expect(valid.remoteOpenchamber.preferredPort).toBe(4096);
    expect(valid.localForward.preferredLocalPort).toBe(65535);
  });

  test('drops registry entries whose port is outside 1-65535', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => JSON.stringify({
      instances: [
        { runtime: 'cli', port: 0, launchMode: 'daemon' },
        { runtime: 'cli', port: -1, launchMode: 'daemon' },
        { runtime: 'cli', port: 65536, launchMode: 'daemon' },
        { runtime: 'cli', port: 99999, launchMode: 'daemon' },
        { runtime: 'cli', port: 4096, launchMode: 'daemon', bindHost: '127.0.0.1' },
      ],
    });

    const servers = await manager.listRemoteServers(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      '/home/pi/.openchamber/npm-global/bin/openchamber',
    );

    expect(servers).toEqual([{ port: 4096, launchMode: 'daemon', bindHost: '127.0.0.1', passwordProtected: null }]);
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
    expect(started).toContain("'/home/pi/.openchamber/npm-global/bin/openchamber' serve --quiet");
    expect(started).toContain("OPENCODE_BINARY='/home/pi/.opencode/bin/opencode'");
    expect(started).toContain('$HOME/.opencode/bin:');
  });

  test('ignores numbers in login-shell banner output before the served port line', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.resolveRemoteTool = async () => '/home/pi/.opencode/bin/opencode';
    // The remote command runs through a login shell (`sh -lc`): a distro
    // banner precedes the serve output and its version number is not a port.
    manager.runRemoteCommand = async () => 'Welcome to Ubuntu 24.04.3 LTS\n4321\n';

    const port = await manager.startRemoteServerManaged(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      { id: 'ssh-1', auth: {}, remoteOpenchamber: { mode: 'managed' } },
      4321,
      '/home/pi/.bun/bin/openchamber',
    );

    expect(port).toBe(4321);
  });

  test('never accepts an out-of-range number as the served port', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.resolveRemoteTool = async () => '/home/pi/.opencode/bin/opencode';
    manager.runRemoteCommand = async () => '99999\n';

    const port = await manager.startRemoteServerManaged(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      { id: 'ssh-1', auth: {}, remoteOpenchamber: { mode: 'managed' } },
      4321,
      '/home/pi/.bun/bin/openchamber',
    );

    expect(port).toBe(4321);
  });

  test('does not let a leading-zero banner line fake the served port', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.resolveRemoteTool = async () => '/home/pi/.opencode/bin/opencode';
    // serve prints the bound port canonically, so a leading-zero line can
    // only be login-shell banner output; the real port line follows it.
    manager.runRemoteCommand = async () => '080\n4321\n';

    const port = await manager.startRemoteServerManaged(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      { id: 'ssh-1', auth: {}, remoteOpenchamber: { mode: 'managed' } },
      4321,
      '/home/pi/.bun/bin/openchamber',
    );

    expect(port).toBe(4321);
  });

  test('falls back to the desired port when the only port-like line has a leading zero', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.resolveRemoteTool = async () => '/home/pi/.opencode/bin/opencode';
    manager.runRemoteCommand = async () => '080 pass:secret\n';

    const port = await manager.startRemoteServerManaged(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      { id: 'ssh-1', auth: {}, remoteOpenchamber: { mode: 'managed' } },
      4321,
      '/home/pi/.bun/bin/openchamber',
    );

    expect(port).toBe(4321);
  });

  test('reads probe statuses by prefix when login-shell banner output precedes them', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    // The probe runs through a login shell (`sh -lc`): a distro banner can
    // precede the status lines, so their position in the output is not fixed.
    manager.runRemoteCommand = async () => [
      'Welcome to Ubuntu 24.04.3 LTS (GNU/Linux 6.8.0 x86_64)',
      'INFO_STATUS=200',
      'AUTH_STATUS=0',
      'HEALTH_STATUS=200',
      JSON.stringify({ openchamberVersion: '1.2.3', runtime: 'web' }),
    ].join('\n');

    const probe = await manager.probeRemoteServer(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      4096,
      null,
    );

    expect(probe).toEqual({
      info: { openchamberVersion: '1.2.3', runtime: 'web' },
      passwordAccepted: false,
      authStatus: 0,
    });
  });

  test('does not let probe statuses with trailing junk fake a healthy server', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => [
      'INFO_STATUS=200junk',
      'AUTH_STATUS=0',
      'HEALTH_STATUS=200.9',
      JSON.stringify({ openchamberVersion: '1.2.3', runtime: 'web' }),
    ].join('\n');

    await expect(manager.probeRemoteServer(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      4096,
      null,
    )).rejects.toThrow(/Remote OpenChamber probe failed \(info status 0, health status 0\)/);
  });

  test('does not let leading-zero probe statuses fake a healthy server', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => [
      'INFO_STATUS=0200',
      'AUTH_STATUS=0',
      'HEALTH_STATUS=000200',
      JSON.stringify({ openchamberVersion: '1.2.3', runtime: 'web' }),
    ].join('\n');

    await expect(manager.probeRemoteServer(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      4096,
      null,
    )).rejects.toThrow(/Remote OpenChamber probe failed \(info status 0, health status 0\)/);
  });

  test('does not let whitespace-padded probe statuses fake a healthy server', async () => {
    // The probe script prints each status with no padding, so a padded
    // spelling can only be login-shell banner output. HEALTH stays 000 so
    // success could only come through the padded info status.
    for (const padded of [' 200', '200 ', '\t200', '200\t']) {
      const manager = new ElectronSshManager({
        settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
        appVersion: '1.2.3',
        emit: () => undefined,
      });
      manager.runRemoteCommand = async () => [
        `INFO_STATUS=${padded}`,
        'AUTH_STATUS=0',
        'HEALTH_STATUS=000',
        JSON.stringify({ openchamberVersion: '1.2.3', runtime: 'web' }),
      ].join('\n');

      await expect(manager.probeRemoteServer(
        { destination: 'user@example.test', args: [] },
        '/tmp/control.sock',
        4096,
        null,
      )).rejects.toThrow(/Remote OpenChamber probe failed \(info status 0, health status 0\)/);
    }

    // A padded health status is judged the same way, with an info status
    // that is not itself a liveness answer.
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => [
      'INFO_STATUS=000',
      'AUTH_STATUS=0',
      'HEALTH_STATUS= 200',
      '{}',
    ].join('\n');

    await expect(manager.probeRemoteServer(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      4096,
      null,
    )).rejects.toThrow(/Remote OpenChamber probe failed \(info status 0, health status 0\)/);
  });

  test('does not report a password accepted on a whitespace-padded auth status', async () => {
    for (const padded of ['200 ', '\t200']) {
      const manager = new ElectronSshManager({
        settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
        appVersion: '1.2.3',
        emit: () => undefined,
      });
      manager.runRemoteCommand = async () => [
        'INFO_STATUS=401',
        `AUTH_STATUS=${padded}`,
        'HEALTH_STATUS=200',
        '{}',
      ].join('\n');

      await expect(manager.probeRemoteServer(
        { destination: 'user@example.test', args: [] },
        '/tmp/control.sock',
        4096,
        'secret',
      )).rejects.toThrow(/configured password was rejected \(auth status 0\)/);
    }
  });

  test('does not report a password accepted on a leading-zero auth status', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => [
      'INFO_STATUS=401',
      'AUTH_STATUS=0200',
      'HEALTH_STATUS=200',
      '{}',
    ].join('\n');

    await expect(manager.probeRemoteServer(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      4096,
      'secret',
    )).rejects.toThrow(/configured password was rejected \(auth status 0\)/);
  });

  test('does not report a password accepted on a junk-suffixed auth status', async () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
      appVersion: '1.2.3',
      emit: () => undefined,
    });
    manager.runRemoteCommand = async () => [
      'INFO_STATUS=401',
      'AUTH_STATUS=200junk',
      'HEALTH_STATUS=200',
      '{}',
    ].join('\n');

    await expect(manager.probeRemoteServer(
      { destination: 'user@example.test', args: [] },
      '/tmp/control.sock',
      4096,
      'secret',
    )).rejects.toThrow(/configured password was rejected \(auth status 0\)/);
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

  describe('managed server reuse', () => {
    const parsed = { destination: 'user@example.test', args: [] };
    const managed = (remoteOpenchamber = {}) => ({
      id: 'ssh-reuse', auth: {}, remoteOpenchamber: { mode: 'managed', installMethod: 'auto', keepRunning: true, ...remoteOpenchamber },
    });

    // A remote host reduced to what the manager asks of it: the CLI registry,
    // the servers answering on their ports, and the serve/stop commands.
    const createRemoteHost = (servers = []) => {
      const host = { servers: [...servers], started: [], stopped: [], statusFails: false, stopFails: false, statusNoise: '' };
      const manager = new ElectronSshManager({
        settingsFilePath: path.join(os.tmpdir(), 'unused-settings.json'),
        appVersion: '1.2.3',
        emit: () => undefined,
      });
      manager.resolveRemoteTool = async () => '/home/pi/.opencode/bin/opencode';
      manager.remoteOpenChamberCandidates = async () => [{ binPath: '/home/pi/.bun/bin/openchamber', version: '1.2.3' }];
      manager.runRemoteCommand = async (_parsed, _controlPath, script) => {
        const probedPort = script.match(/127\.0\.0\.1:(\d+)\/api\/system\/info/);
        if (probedPort) {
          const server = host.servers.find((entry) => entry.port === Number(probedPort[1]));
          if (!server) return 'INFO_STATUS=000\nAUTH_STATUS=0\nHEALTH_STATUS=000\n';
          // /api/system/info is public, so only the auth status tells a fitting password apart.
          const offered = script.match(/"password":"([^"]*)"/);
          let authStatus = 0;
          if (offered) authStatus = !server.password ? 400 : offered[1] === server.password ? 200 : 401;
          if (offered && server.rateLimited) authStatus = 429;
          return `INFO_STATUS=200\nAUTH_STATUS=${authStatus}\nHEALTH_STATUS=200\n${JSON.stringify({ openchamberVersion: server.version, runtime: 'web' })}`;
        }
        if (script.endsWith(' status --json')) {
          if (host.statusFails) throw new Error('status unavailable');
          return host.statusNoise + JSON.stringify({
            state: 'running',
            instances: host.servers.filter((entry) => entry.registered !== false).map((entry) => ({
              runtime: 'cli', port: entry.port, launchMode: entry.launchMode || 'daemon', bindHost: entry.bindHost || '127.0.0.1', passwordProtected: Boolean(entry.password),
            })),
          });
        }
        const stoppedPort = script.match(/ stop --port (\d+)$/);
        if (stoppedPort) {
          host.stopped.push(Number(stoppedPort[1]));
          if (host.stopFails) return '';
          host.servers = host.servers.filter((entry) => entry.port !== Number(stoppedPort[1]));
          return '';
        }
        const servedPort = script.match(/ serve --quiet --hostname (\S+) --port (\d+)$/);
        if (servedPort) {
          host.started.push(Number(servedPort[2]));
          const servedPassword = script.match(/OPENCHAMBER_UI_PASSWORD='([^']*)'/);
          host.servers.push({ port: Number(servedPort[2]), version: '1.2.3', bindHost: servedPort[1], password: servedPassword?.[1] });
          return `${servedPort[2]}\n`;
        }
        throw new Error(`Unexpected remote command: ${script}`);
      };
      return { host, manager };
    };

    test('reconnecting reuses the server the previous connect left running', async () => {
      const { host, manager } = createRemoteHost();

      const first = await manager.ensureRemoteServer(managed(), parsed, '/unused.sock');
      const second = await manager.ensureRemoteServer(managed(), parsed, '/unused.sock');

      expect(first.startedByUs).toBe(true);
      expect(second).toEqual({ remotePort: first.remotePort, startedByUs: false, ownsRemoteServer: true, remoteBinPath: '/home/pi/.bun/bin/openchamber' });
      expect(host.started).toEqual([first.remotePort]);
      expect(host.servers).toHaveLength(1);
    });

    test('replaces a daemon left by another app version instead of starting next to it', async () => {
      const { host, manager } = createRemoteHost([{ port: 30001, version: '1.1.0' }]);

      const result = await manager.ensureRemoteServer(managed(), parsed, '/unused.sock');

      expect(host.stopped).toEqual([30001]);
      expect(result.startedByUs).toBe(true);
      expect(host.servers.map((entry) => entry.version)).toEqual(['1.2.3']);
    });

    test('leaves a foreground server of another version to its process manager', async () => {
      const { host, manager } = createRemoteHost([{ port: 30001, version: '1.1.0', launchMode: 'foreground' }]);

      const result = await manager.ensureRemoteServer(managed(), parsed, '/unused.sock');

      expect(host.stopped).toEqual([]);
      expect(result.startedByUs).toBe(true);
      expect(result.remotePort).not.toBe(30001);
    });

    test('does not hand a loopback-only server to an instance published to the network', async () => {
      const { host, manager } = createRemoteHost([{ port: 30001, version: '1.2.3', bindHost: '127.0.0.1', password: 'remote-secret' }]);
      const exposed = {
        ...managed({ bindHost: '0.0.0.0' }),
        auth: { openchamberPassword: { enabled: true, value: 'remote-secret', store: 'settings' } },
      };

      await manager.ensureRemoteServer(exposed, parsed, '/unused.sock');

      expect(host.stopped).toEqual([30001]);
      expect(host.servers.map((entry) => entry.bindHost)).toEqual(['0.0.0.0']);
    });

    const withPassword = (value, remoteOpenchamber) => ({
      ...managed(remoteOpenchamber),
      auth: { openchamberPassword: { enabled: true, value, store: 'settings' } },
    });

    test('neither reuses nor stops a server that rejects the instance password', async () => {
      const { host, manager } = createRemoteHost([
        { port: 30001, version: '1.2.3', password: 'old-secret' },
        { port: 30002, version: '1.1.0', password: 'someone-else' },
        { port: 30003, version: '1.2.3' },
      ]);

      const result = await manager.ensureRemoteServer(withPassword('new-secret'), parsed, '/unused.sock');

      expect(host.stopped).toEqual([]);
      expect(result.startedByUs).toBe(true);
      expect(host.servers.find((entry) => entry.port === result.remotePort).password).toBe('new-secret');
    });

    test('an instance without a password leaves password-protected servers alone', async () => {
      const { host, manager } = createRemoteHost([{ port: 30001, version: '1.1.0', password: 'secret' }]);

      const result = await manager.ensureRemoteServer(managed(), parsed, '/unused.sock');

      expect(host.stopped).toEqual([]);
      expect(result.remotePort).not.toBe(30001);
    });

    test('reuses the server that accepts the instance password', async () => {
      const { host, manager } = createRemoteHost([
        { port: 30001, version: '1.2.3', password: 'someone-else' },
        { port: 30002, version: '1.2.3', password: 'remote-secret' },
      ]);

      const result = await manager.ensureRemoteServer(withPassword('remote-secret'), parsed, '/unused.sock');

      expect(result).toMatchObject({ remotePort: 30002, startedByUs: false });
      expect(host.started).toEqual([]);
    });

    test('owns an adopted daemon but not an adopted foreground server', async () => {
      const daemon = createRemoteHost([{ port: 30001, version: '1.2.3' }]);
      const foreground = createRemoteHost([{ port: 30001, version: '1.2.3', launchMode: 'foreground' }]);

      expect((await daemon.manager.ensureRemoteServer(managed(), parsed, '/unused.sock')).ownsRemoteServer).toBe(true);
      expect((await foreground.manager.ensureRemoteServer(managed(), parsed, '/unused.sock')).ownsRemoteServer).toBe(false);
    });

    test('replaces a server still published to the network after the instance stopped publishing', async () => {
      const { host, manager } = createRemoteHost([{ port: 30001, version: '1.2.3', bindHost: '0.0.0.0', password: 'remote-secret' }]);

      await manager.ensureRemoteServer(withPassword('remote-secret'), parsed, '/unused.sock');

      expect(host.stopped).toEqual([30001]);
      expect(host.servers.map((entry) => entry.bindHost)).toEqual(['127.0.0.1']);
    });

    test('reads the registry past shell profile output', async () => {
      const { host, manager } = createRemoteHost([{ port: 30001, version: '1.2.3' }]);
      host.statusNoise = 'Welcome back\n';

      const result = await manager.ensureRemoteServer(managed(), parsed, '/unused.sock');

      expect(result).toMatchObject({ remotePort: 30001, startedByUs: false });
    });

    test('says in the connect log why a registered server was passed over', async () => {
      const { host, manager } = createRemoteHost([{ port: 30001, version: '1.1.0', password: 'remote-secret', rateLimited: true }]);

      await manager.ensureRemoteServer(withPassword('remote-secret'), parsed, '/unused.sock');

      expect(host.stopped).toEqual([]);
      expect(manager.logsForInstance('ssh-reuse', 50).join('\n')).toContain('remote port 30001: it does not take this instance\'s UI password (auth status 429)');
    });

    test('disconnecting with keepRunning off stops an adopted daemon', async () => {
      const { host, manager } = createRemoteHost([{ port: 30001, version: '1.2.3' }]);
      const instance = managed({ keepRunning: false });
      const { remotePort, ownsRemoteServer, remoteBinPath } = await manager.ensureRemoteServer(instance, parsed, '/unused.sock');
      manager.stopControlMasterBestEffort = async () => undefined;
      manager.sessions.set(instance.id, {
        instance, parsed, controlPath: '/unused.sock', askpassCleanupPaths: [], remotePort, ownsRemoteServer, remoteBinPath,
        startedByUs: false, master: null, mainForward: null, extraForwards: [],
      });

      await manager.disconnectInternal(instance.id, false);

      expect(host.stopped).toEqual([30001]);
    });

    test('falls back to the stale server on a pinned port when it cannot be stopped', async () => {
      const { host, manager } = createRemoteHost([{ port: 30777, version: '1.1.0' }]);
      host.stopFails = true;

      const result = await manager.ensureRemoteServer(managed({ preferredPort: 30777 }), parsed, '/unused.sock');

      expect(host.stopped).toEqual([30777]);
      expect(result).toMatchObject({ remotePort: 30777, startedByUs: false });
      expect(host.started).toEqual([]);
    });

    test('keeps reusing a pinned port the registry does not know about', async () => {
      const { host, manager } = createRemoteHost([
        { port: 30001, version: '1.2.3' },
        { port: 30777, version: '1.1.0', registered: false },
      ]);

      const result = await manager.ensureRemoteServer(managed({ preferredPort: 30777 }), parsed, '/unused.sock');

      expect(result).toMatchObject({ remotePort: 30777, startedByUs: false });
      expect(host.started).toEqual([]);
      expect(host.stopped).toEqual([]);
    });

    test('starts a server and logs why when the remote registry cannot be read', async () => {
      const { host, manager } = createRemoteHost([{ port: 30001, version: '1.2.3' }]);
      host.statusFails = true;

      const result = await manager.ensureRemoteServer(managed(), parsed, '/unused.sock');

      expect(result.startedByUs).toBe(true);
      expect(manager.logsForInstance('ssh-reuse', 50).join('\n')).toContain('Could not list OpenChamber servers');
    });
  });
});
