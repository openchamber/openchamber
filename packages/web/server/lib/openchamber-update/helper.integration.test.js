import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getPackageManagerLaunchSpec } from '../package-manager.js';
import { deleteOneShotRequest } from './helper.mjs';
import { readActiveUpdateMaintenance } from './maintenance.js';

const helperPath = fileURLToPath(new URL('./helper.mjs', import.meta.url));
const runtimeUrl = pathToFileURL(fileURLToPath(new URL('./runtime.js', import.meta.url))).href;
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber updater fixtures '));
const artifactsDirectory = path.join(fixtureRoot, 'artifacts');
const npmLaunch = getPackageManagerLaunchSpec('npm');
const fixtureTarballs = new Map();

function mergeEnvironment(...sources) {
  const result = {};
  const keys = new Map();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      const normalizedKey = process.platform === 'win32' ? key.toLowerCase() : key;
      const previousKey = keys.get(normalizedKey);
      if (previousKey && previousKey !== key) delete result[previousKey];
      result[key] = value;
      keys.set(normalizedKey, key);
    }
  }
  return result;
}

function runNpm(args, options = {}) {
  const result = spawnSync(npmLaunch.command, [...npmLaunch.argsPrefix, ...args], {
    cwd: options.cwd,
    env: mergeEnvironment(process.env, options.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = result.error?.message || (result.stderr || result.stdout || '').trim();
    throw new Error(`npm ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

function writeFixturePackage(version, options = {}) {
  const directory = path.join(fixtureRoot, `package-${version}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: '@openchamber/web',
    version,
    type: 'module',
    files: ['launcher.mjs', 'server.mjs'],
  }, null, 2));
  fs.writeFileSync(path.join(directory, 'launcher.mjs'), options.brokenLauncher ? `process.exit(17);\n` : `
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(directory, 'server.mjs'), process.argv[2], process.argv[3]], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
`);
  fs.writeFileSync(path.join(directory, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
const packageJson = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const port = Number(process.argv[2]);
const pidPath = process.argv[3];
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'ok', openchamberVersion: packageJson.version }));
    return;
  }
  response.statusCode = 404;
  response.end();
});
server.listen(port, '127.0.0.1', () => fs.writeFileSync(pidPath, String(process.pid)));
`);

  runNpm(['pack', '--pack-destination', artifactsDirectory], { cwd: directory });
  const tarball = fs.readdirSync(artifactsDirectory)
    .map((name) => path.join(artifactsDirectory, name))
    .find((candidate) => candidate.endsWith(`-${version}.tgz`));
  if (!tarball) throw new Error(`Fixture tarball for ${version} was not created`);
  fixtureTarballs.set(version, tarball);
}

function getInstalledPackagePath(prefix) {
  const nodeModules = process.platform === 'win32'
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib', 'node_modules');
  return path.join(nodeModules, '@openchamber', 'web');
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function runHelper(request, transactionDirectory) {
  const requestPath = path.join(transactionDirectory, 'request.json');
  const logPath = path.join(transactionDirectory, 'update.log');
  fs.mkdirSync(transactionDirectory, { recursive: true });
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2), { mode: 0o600 });
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [helperPath, requestPath], {
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  fs.closeSync(logFd);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (exitCode !== 0) {
    let status = 'unavailable';
    let log = 'unavailable';
    try { status = fs.readFileSync(path.join(transactionDirectory, 'status.json'), 'utf8'); } catch {}
    try { log = fs.readFileSync(logPath, 'utf8'); } catch {}
    throw new Error(`Updater helper exited with code ${exitCode}\nstatus:\n${status}\nlog:\n${log}`);
  }
  return { exitCode, requestPath, logPath };
}

function stopFixtureServer(pidPath) {
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) process.kill(pid);
  } catch {
  }
}

async function waitForTerminalStatus(statusPath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      if (status.state === 'healthy' || status.state === 'failed' || status.state === 'recovered-old-version') {
        return status;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Updater transaction did not reach a terminal state');
}

beforeAll(() => {
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  writeFixturePackage('0.0.1');
  writeFixturePackage('0.0.2');
  writeFixturePackage('0.0.4', { brokenLauncher: true });
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('standalone updater helper', () => {
  it('scrubs secrets and fails closed when the one-shot request cannot be deleted', () => {
    const writes = [];
    const fsLike = {
      unlinkSync() {
        throw new Error('locked');
      },
      writeFileSync(filePath, contents, options) {
        writes.push({ filePath, contents, options });
      },
    };

    expect(() => deleteOneShotRequest('/tmp/request.json', fsLike)).toThrow('Unable to delete');
    expect(writes).toEqual([{
      filePath: '/tmp/request.json',
      contents: '{}\n',
      options: { mode: 0o600 },
    }]);
  });

  it('replaces an isolated global npm package and verifies replacement health', async () => {
    const testDirectory = path.join(fixtureRoot, 'success with spaces');
    const prefix = path.join(testDirectory, 'npm prefix');
    const transactionDirectory = path.join(testDirectory, 'transaction');
    const packagePath = getInstalledPackagePath(prefix);
    const statusPath = path.join(transactionDirectory, 'status.json');
    const markerPath = path.join(testDirectory, 'run', 'openchamber-update.lock', 'marker.json');
    const serverPidPath = path.join(testDirectory, 'server.pid');
    const port = await getFreePort();
    const secret = 'password with & ^ " shell characters';
    const npmEnv = { npm_config_prefix: prefix };
    runNpm(['install', '-g', fixtureTarballs.get('0.0.1')], { env: npmEnv });

    try {
      const result = await runHelper({
        id: 'fixture-success',
        statusPath,
        markerPath,
        currentVersion: '0.0.1',
        targetVersion: '0.0.2',
        packageManager: 'npm',
        packagePath,
        oldPid: 2_147_483_647,
        install: {
          command: npmLaunch.command,
          args: [...npmLaunch.argsPrefix, 'install', '-g', fixtureTarballs.get('0.0.2')],
          env: npmEnv,
        },
        restart: {
          mode: 'daemon',
          command: process.execPath,
          args: [path.join(packagePath, 'launcher.mjs'), String(port), serverPidPath],
          env: { OPENCHAMBER_UI_PASSWORD: secret },
          healthUrl: `http://127.0.0.1:${port}/health`,
        },
      }, transactionDirectory);

      const statusText = fs.readFileSync(statusPath, 'utf8');
      const status = JSON.parse(statusText);
      const logText = fs.readFileSync(result.logPath, 'utf8');
      expect(result.exitCode).toBe(0);
      expect(status).toMatchObject({ state: 'healthy', installedVersion: '0.0.2' });
      expect(JSON.parse(fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8')).version).toBe('0.0.2');
      expect(fs.existsSync(result.requestPath)).toBe(false);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(statusText).not.toContain(secret);
      expect(logText).not.toContain(secret);
    } finally {
      stopFixtureServer(serverPidPath);
    }
  }, 30_000);

  it('reinstalls and recovers the old version after partial replacement', async () => {
    const testDirectory = path.join(fixtureRoot, 'failure recovery');
    const prefix = path.join(testDirectory, 'npm prefix');
    const transactionDirectory = path.join(testDirectory, 'transaction');
    const packagePath = getInstalledPackagePath(prefix);
    const statusPath = path.join(transactionDirectory, 'status.json');
    const markerPath = path.join(testDirectory, 'run', 'openchamber-update.lock', 'marker.json');
    const serverPidPath = path.join(testDirectory, 'server.pid');
    const port = await getFreePort();
    runNpm(['install', '-g', fixtureTarballs.get('0.0.1')], { env: { npm_config_prefix: prefix } });

    try {
      const result = await runHelper({
        id: 'fixture-failure',
        statusPath,
        markerPath,
        currentVersion: '0.0.1',
        targetVersion: '0.0.3',
        packageManager: 'npm',
        packagePath,
        oldPid: 2_147_483_647,
        install: {
          command: npmLaunch.command,
          args: [...npmLaunch.argsPrefix, 'install', '-g', fixtureTarballs.get('0.0.2')],
          env: { npm_config_prefix: prefix },
        },
        rollback: {
          command: npmLaunch.command,
          args: [...npmLaunch.argsPrefix, 'install', '-g', fixtureTarballs.get('0.0.1')],
          env: { npm_config_prefix: prefix },
        },
        restart: {
          mode: 'daemon',
          command: process.execPath,
          args: [path.join(packagePath, 'launcher.mjs'), String(port), serverPidPath],
          env: {},
          healthUrl: `http://127.0.0.1:${port}/health`,
        },
      }, transactionDirectory);

      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      expect(result.exitCode).toBe(0);
      expect(status).toMatchObject({
        state: 'recovered-old-version',
        installedVersion: '0.0.1',
        errorCode: 'version-mismatch',
      });
      expect(JSON.parse(fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8')).version).toBe('0.0.1');
    } finally {
      stopFixtureServer(serverPidPath);
    }
  }, 30_000);

  it('uses a service-manager restart command without launching a duplicate daemon', async () => {
    const testDirectory = path.join(fixtureRoot, 'service restart');
    const prefix = path.join(testDirectory, 'npm prefix');
    const transactionDirectory = path.join(testDirectory, 'transaction');
    const packagePath = getInstalledPackagePath(prefix);
    const statusPath = path.join(transactionDirectory, 'status.json');
    const markerPath = path.join(testDirectory, 'run', 'openchamber-update.lock', 'marker.json');
    const serverPidPath = path.join(testDirectory, 'server.pid');
    const port = await getFreePort();
    fs.mkdirSync(testDirectory, { recursive: true });
    runNpm(['install', '-g', fixtureTarballs.get('0.0.2')], { env: { npm_config_prefix: prefix } });

    try {
      const result = await runHelper({
        id: 'fixture-service',
        statusPath,
        markerPath,
        currentVersion: '0.0.1',
        targetVersion: '0.0.2',
        packageManager: 'npm',
        packagePath,
        oldPid: 2_147_483_647,
        install: {
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
        },
        restart: {
          mode: 'service',
          command: 'this-daemon-command-must-not-run',
          args: [],
          env: {},
          serviceCommand: process.execPath,
          serviceArgs: [path.join(packagePath, 'launcher.mjs'), String(port), serverPidPath],
          healthUrl: `http://127.0.0.1:${port}/health`,
        },
      }, transactionDirectory);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({
        state: 'healthy',
        installedVersion: '0.0.2',
      });
    } finally {
      stopFixtureServer(serverPidPath);
    }
  }, 30_000);

  it('waits for a passive service manager to restart the foreground server', async () => {
    const testDirectory = path.join(fixtureRoot, 'passive service restart');
    const prefix = path.join(testDirectory, 'npm prefix');
    const transactionDirectory = path.join(testDirectory, 'transaction');
    const packagePath = getInstalledPackagePath(prefix);
    const statusPath = path.join(transactionDirectory, 'status.json');
    const markerPath = path.join(testDirectory, 'run', 'openchamber-update.lock', 'marker.json');
    const serverPidPath = path.join(testDirectory, 'server.pid');
    const port = await getFreePort();
    fs.mkdirSync(testDirectory, { recursive: true });
    runNpm(['install', '-g', fixtureTarballs.get('0.0.2')], { env: { npm_config_prefix: prefix } });

    const helperPromise = runHelper({
      id: 'fixture-passive-service',
      statusPath,
      markerPath,
      currentVersion: '0.0.1',
      targetVersion: '0.0.2',
      packageManager: 'npm',
      packagePath,
      oldPid: 2_147_483_647,
      install: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
      restart: {
        mode: 'service',
        serviceManager: 'systemd',
        healthUrl: `http://127.0.0.1:${port}/health`,
      },
    }, transactionDirectory);
    const supervisorPromise = (async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
          if (status.state === 'awaiting-service-restart' || status.state === 'checking-health') {
            const child = spawn(process.execPath, [
              path.join(packagePath, 'launcher.mjs'),
              String(port),
              serverPidPath,
            ], { stdio: 'ignore', windowsHide: true });
            await new Promise((resolve, reject) => {
              child.once('error', reject);
              child.once('exit', resolve);
            });
            return;
          }
        } catch {
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Helper did not reach passive service restart state');
    })();

    try {
      const [result] = await Promise.all([helperPromise, supervisorPromise]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({
        state: 'healthy',
        installedVersion: '0.0.2',
      });
    } finally {
      stopFixtureServer(serverPidPath);
    }
  }, 30_000);

  it('retries a Windows Scheduled Task until exact-version health succeeds', async () => {
    const testDirectory = path.join(fixtureRoot, 'windows task retry');
    const prefix = path.join(testDirectory, 'npm prefix');
    const transactionDirectory = path.join(testDirectory, 'transaction');
    const packagePath = getInstalledPackagePath(prefix);
    const statusPath = path.join(transactionDirectory, 'status.json');
    const markerPath = path.join(testDirectory, 'run', 'openchamber-update.lock', 'marker.json');
    const serverPidPath = path.join(testDirectory, 'server.pid');
    const attemptPath = path.join(testDirectory, 'restart-attempt.txt');
    const restartScriptPath = path.join(testDirectory, 'restart-task.mjs');
    const port = await getFreePort();
    fs.mkdirSync(testDirectory, { recursive: true });
    runNpm(['install', '-g', fixtureTarballs.get('0.0.2')], { env: { npm_config_prefix: prefix } });
    fs.writeFileSync(restartScriptPath, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const attemptPath = process.argv[2];
const attempt = Number(fs.existsSync(attemptPath) ? fs.readFileSync(attemptPath, 'utf8') : '0') + 1;
fs.writeFileSync(attemptPath, String(attempt));
if (attempt < 3) process.exit(1);
const child = spawn(process.execPath, process.argv.slice(3), { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
`);

    try {
      const result = await runHelper({
        id: 'fixture-windows-task',
        statusPath,
        markerPath,
        currentVersion: '0.0.1',
        targetVersion: '0.0.2',
        packageManager: 'npm',
        packagePath,
        oldPid: 2_147_483_647,
        install: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
        restart: {
          mode: 'service',
          serviceManager: 'windows-task',
          serviceCommand: process.execPath,
          serviceArgs: [
            restartScriptPath,
            attemptPath,
            path.join(packagePath, 'server.mjs'),
            String(port),
            serverPidPath,
          ],
          healthUrl: `http://127.0.0.1:${port}/health`,
        },
      }, transactionDirectory);

      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(attemptPath, 'utf8')).toBe('3');
      expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toMatchObject({ state: 'healthy' });
    } finally {
      stopFixtureServer(serverPidPath);
    }
  }, 30_000);

  it('rolls back when the exact target installs but cannot start', async () => {
    const testDirectory = path.join(fixtureRoot, 'broken target rollback');
    const prefix = path.join(testDirectory, 'npm prefix');
    const transactionDirectory = path.join(testDirectory, 'transaction');
    const packagePath = getInstalledPackagePath(prefix);
    const statusPath = path.join(transactionDirectory, 'status.json');
    const markerPath = path.join(testDirectory, 'run', 'openchamber-update.lock', 'marker.json');
    const serverPidPath = path.join(testDirectory, 'server.pid');
    const port = await getFreePort();
    const npmEnv = { npm_config_prefix: prefix };
    runNpm(['install', '-g', fixtureTarballs.get('0.0.1')], { env: npmEnv });

    try {
      const result = await runHelper({
        id: 'fixture-broken-target',
        statusPath,
        markerPath,
        currentVersion: '0.0.1',
        targetVersion: '0.0.4',
        packageManager: 'npm',
        packagePath,
        oldPid: 2_147_483_647,
        install: {
          command: npmLaunch.command,
          args: [...npmLaunch.argsPrefix, 'install', '-g', fixtureTarballs.get('0.0.4')],
          env: npmEnv,
        },
        rollback: {
          command: npmLaunch.command,
          args: [...npmLaunch.argsPrefix, 'install', '-g', fixtureTarballs.get('0.0.1')],
          env: npmEnv,
        },
        stop: {
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
        },
        restart: {
          mode: 'daemon',
          command: process.execPath,
          args: [path.join(packagePath, 'launcher.mjs'), String(port), serverPidPath],
          env: { OPENCHAMBER_UPDATE_TRANSACTION_ID: 'fixture-broken-target' },
          healthUrl: `http://127.0.0.1:${port}/health`,
        },
      }, transactionDirectory);

      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      expect(result.exitCode).toBe(0);
      expect(status).toMatchObject({
        state: 'recovered-old-version',
        installedVersion: '0.0.1',
        errorCode: 'restart-failed',
      });
      expect(JSON.parse(fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8')).version).toBe('0.0.1');
    } finally {
      stopFixtureServer(serverPidPath);
    }
  }, 30_000);

  it('terminates a timed-out installer tree before recovering', async () => {
    const testDirectory = path.join(fixtureRoot, 'installer timeout');
    const prefix = path.join(testDirectory, 'npm prefix');
    const transactionDirectory = path.join(testDirectory, 'transaction');
    const packagePath = getInstalledPackagePath(prefix);
    const statusPath = path.join(transactionDirectory, 'status.json');
    const markerPath = path.join(testDirectory, 'run', 'openchamber-update.lock', 'marker.json');
    const serverPidPath = path.join(testDirectory, 'server.pid');
    const sentinelPath = path.join(testDirectory, 'installer-child-survived');
    const hangingInstallerPath = path.join(testDirectory, 'hanging-installer.mjs');
    const port = await getFreePort();
    fs.mkdirSync(testDirectory, { recursive: true });
    runNpm(['install', '-g', fixtureTarballs.get('0.0.1')], { env: { npm_config_prefix: prefix } });
    fs.writeFileSync(hangingInstallerPath, `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'survived'), 3500); setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });
child.unref();
setInterval(() => {}, 1000);
`);

    try {
      const result = await runHelper({
        id: 'fixture-timeout',
        statusPath,
        markerPath,
        currentVersion: '0.0.1',
        targetVersion: '0.0.2',
        packageManager: 'npm',
        packagePath,
        oldPid: 2_147_483_647,
        install: {
          command: process.execPath,
          args: [hangingInstallerPath],
          timeoutMs: 300,
        },
        restart: {
          mode: 'daemon',
          command: process.execPath,
          args: [path.join(packagePath, 'launcher.mjs'), String(port), serverPidPath],
          env: { OPENCHAMBER_UPDATE_TRANSACTION_ID: 'fixture-timeout' },
          healthUrl: `http://127.0.0.1:${port}/health`,
        },
      }, transactionDirectory);

      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      expect(result.exitCode).toBe(0);
      expect(status).toMatchObject({
        state: 'recovered-old-version',
        installedVersion: '0.0.1',
        errorCode: 'process-timeout',
      });
      await new Promise((resolve) => setTimeout(resolve, 3700));
      expect(fs.existsSync(sentinelPath)).toBe(false);
    } finally {
      stopFixtureServer(serverPidPath);
    }
  }, 30_000);

  it('keeps a durable recovery gate when the helper is killed during installation', async () => {
    const testDirectory = path.join(fixtureRoot, 'killed helper recovery gate');
    const dataDirectory = path.join(testDirectory, 'data');
    const transactionDirectory = path.join(dataDirectory, 'updates', 'fixture-killed-helper');
    const packagePath = path.join(testDirectory, 'installed package');
    const requestPath = path.join(transactionDirectory, 'request.json');
    const statusPath = path.join(transactionDirectory, 'status.json');
    const markerPath = path.join(dataDirectory, 'run', 'openchamber-update.lock', 'marker.json');
    const installerPath = path.join(testDirectory, 'installer.mjs');
    const installerPidPath = path.join(testDirectory, 'installer.pid');
    fs.mkdirSync(packagePath, { recursive: true });
    fs.mkdirSync(transactionDirectory, { recursive: true });
    fs.writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    fs.writeFileSync(installerPath, `
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`);
    fs.writeFileSync(requestPath, JSON.stringify({
      id: 'fixture-killed-helper',
      statusPath,
      markerPath,
      currentVersion: '0.0.1',
      targetVersion: '0.0.2',
      packageManager: 'npm',
      packagePath,
      oldPid: 2_147_483_647,
      install: { command: process.execPath, args: [installerPath, installerPidPath] },
      restart: {
        mode: 'daemon',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        healthUrl: 'http://127.0.0.1:1/health',
      },
    }));
    const helper = spawn(process.execPath, [helperPath, requestPath], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let installerPid = null;

    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
          if (status.state === 'installing' && fs.existsSync(installerPidPath)) {
            installerPid = Number(fs.readFileSync(installerPidPath, 'utf8'));
            break;
          }
        } catch {
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(Number.isInteger(installerPid)).toBe(true);

      helper.kill();
      await new Promise((resolve) => helper.once('exit', resolve));

      expect(readActiveUpdateMaintenance({ openchamberDataDir: dataDirectory })).toMatchObject({
        id: 'fixture-killed-helper',
        requiresRecovery: true,
        recoveryTargetVersion: '0.0.2',
      });
      expect(fs.existsSync(markerPath)).toBe(true);
    } finally {
      try {
        helper.kill();
      } catch {
      }
      if (Number.isInteger(installerPid)) {
        try {
          process.kill(installerPid);
        } catch {
        }
      }
    }
  }, 15_000);

  it('keeps the detached helper alive after the preparing parent exits', async () => {
    const testDirectory = path.join(fixtureRoot, 'parent exit');
    const packagePath = path.join(testDirectory, 'installed package');
    const dataDirectory = path.join(testDirectory, 'data');
    const parentConfigPath = path.join(testDirectory, 'parent-config.json');
    const transactionResultPath = path.join(testDirectory, 'transaction-result.json');
    const installerPath = path.join(testDirectory, 'installer.mjs');
    const parentPath = path.join(testDirectory, 'parent.mjs');
    const serverPidPath = path.join(testDirectory, 'server.pid');
    const port = await getFreePort();
    fs.mkdirSync(packagePath, { recursive: true });
    fs.copyFileSync(path.join(fixtureRoot, 'package-0.0.2', 'launcher.mjs'), path.join(packagePath, 'launcher.mjs'));
    fs.copyFileSync(path.join(fixtureRoot, 'package-0.0.2', 'server.mjs'), path.join(packagePath, 'server.mjs'));
    fs.writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ name: '@openchamber/web', version: '0.0.1', type: 'module' }));
    fs.writeFileSync(installerPath, `
import fs from 'node:fs';
import path from 'node:path';
const packagePath = process.argv[2];
const packageJsonPath = path.join(packagePath, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
packageJson.version = '0.0.2';
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson));
`);
    fs.writeFileSync(parentPath, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { startUpdateTransaction } = await import(config.runtimeUrl);
const transaction = await startUpdateTransaction({
  ...config.options,
  oldPid: process.pid,
  spawnChild: spawn,
});
fs.writeFileSync(config.resultPath, JSON.stringify(transaction));
`);
    fs.writeFileSync(parentConfigPath, JSON.stringify({
      runtimeUrl,
      resultPath: transactionResultPath,
      options: {
        openchamberDataDir: dataDirectory,
        currentVersion: '0.0.1',
        targetVersion: '0.0.2',
        packageManager: 'npm',
        packagePath,
        install: { command: process.execPath, args: [installerPath, packagePath] },
        restart: {
          mode: 'daemon',
          command: process.execPath,
          args: [path.join(packagePath, 'launcher.mjs'), String(port), serverPidPath],
          env: {},
          healthUrl: `http://127.0.0.1:${port}/health`,
        },
      },
    }));

    const parent = spawn(process.execPath, [parentPath, parentConfigPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let parentStderr = '';
    parent.stderr.on('data', (chunk) => { parentStderr += chunk.toString(); });
    const parentExitCode = await new Promise((resolve, reject) => {
      parent.once('error', reject);
      parent.once('exit', resolve);
    });
    expect(parentExitCode, parentStderr).toBe(0);

    const transaction = JSON.parse(fs.readFileSync(transactionResultPath, 'utf8'));
    try {
      const status = await waitForTerminalStatus(transaction.statusPath);
      expect(status).toMatchObject({ state: 'healthy', installedVersion: '0.0.2' });
      expect(status.helperPid).not.toBe(parent.pid);
    } finally {
      stopFixtureServer(serverPidPath);
    }
  }, 30_000);
});
