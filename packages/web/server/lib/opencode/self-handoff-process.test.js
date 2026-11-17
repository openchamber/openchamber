import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// Real processes throughout: the CLI runs `serve --foreground` on a random port with a temporary HOME,
// and the OpenCode child is a fake that answers the 2.x endpoints the lifecycle probes.
const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, '../../../bin/cli.js');

const fakeOpenCodeSource = `
  const http = require('node:http');
  const args = process.argv.slice(2);
  if (args.includes('--version')) { console.log('2.0.26'); process.exit(0); }
  const host = args[args.indexOf('--hostname') + 1];
  const port = Number(args[args.indexOf('--port') + 1]);
  // Every fake records its pid, so teardown can stop the ones a failing handoff left behind.
  require('node:fs').appendFileSync(require('node:path').join(__dirname, 'opencode-pids'), process.pid + '\\n');
  const server = http.createServer((req, res) => {
    if (req.url === '/api/info' || req.url === '/global/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy: true, version: '2.0.26', pid: process.pid }));
      return;
    }
    if (req.url === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const timer = setInterval(() => res.write(': keep-alive\\n\\n'), 1000);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, host, () => console.log('server listening on http://' + host + ':' + port));
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Vitest does not print console output here, so each run's counts go to SELF_HANDOFF_REPORT (a file) when set.
const report = (entry) => {
  if (process.env.SELF_HANDOFF_REPORT) fs.appendFileSync(process.env.SELF_HANDOFF_REPORT, `${JSON.stringify(entry)}\n`);
};

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Probe-and-release, the same shape gatekeeper-program.test.js raced on (#666). Two of this
// file's call sites never bind the port at all: it only names a pid file in readiness-timeout
// tests whose child has already exited or never listens, so those cannot collide, and they
// keep using this helper directly. The server starts below go through startReadyServer,
// which retries a start whose child dies on EADDRINUSE with a fresh port (#676).
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// The environment a test child sees: the host's own OpenChamber and OpenCode settings, the systemd notify
// socket and the listen-fd convention are removed, so nothing reaches a live instance.
const scrubbedEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(OPENCHAMBER_|OPENCODE_|LISTEN_|NOTIFY_SOCKET|NODE_CHANNEL)/.test(key)) delete env[key];
  }
  return env;
};

const createSandbox = async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-selfhandoff-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(bin, { recursive: true });
  const fakeScript = path.join(root, 'fake-opencode.cjs');
  const opencode = path.join(bin, 'opencode');
  await fsp.writeFile(fakeScript, fakeOpenCodeSource);
  await fsp.writeFile(opencode, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeScript)} "$@"\n`, { mode: 0o755 });
  const env = {
    ...scrubbedEnv(),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCODE_BINARY: opencode,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    OPENCHAMBER_HANDOFF_TIMEOUT_MS: '20000',
  };
  const dataDir = path.join(home, '.config', 'openchamber');
  return {
    root,
    env,
    dataDir,
    statePath: path.join(dataDir, 'managed-opencode', 'state.json'),
    pidFilePath: (port) => path.join(dataDir, 'run', `openchamber-${port}.pid`),
    logPath: (name) => path.join(root, `${name}.log`),
  };
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const readPid = (file) => {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
};

const fetchHealth = (port) => new Promise((resolve) => {
  const request = http.get({ host: '127.0.0.1', port, path: '/health', agent: false, timeout: 2000 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      try {
        resolve({ status: response.statusCode, body: JSON.parse(body) });
      } catch {
        resolve({ status: response.statusCode, body: null });
      }
    });
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => resolve(null));
});

const readLogTail = (logPath, maxLines = 40) => {
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return null;
  }
};

// What a readiness timeout reports alongside the bare message: whether the server process is still
// running or has exited (and how), what the pid file names, and the tail of the server log. Without
// this a recurrence cannot be told apart as a crash, a hung start, or a merely slow start under load.
const readinessDiagnostics = ({ child, logPath, pidFilePath }) => {
  const lines = [];
  if (child) {
    if (child.exitCode !== null || child.signalCode !== null) {
      lines.push(`server process ${child.pid} has exited (exit code ${child.exitCode}, signal ${child.signalCode})`);
    } else {
      lines.push(`server process ${child.pid} is still running`);
    }
  }
  if (pidFilePath) {
    const pid = readPid(pidFilePath);
    if (pid === null) {
      lines.push(fs.existsSync(pidFilePath)
        ? `pid file ${pidFilePath} exists but does not name a pid`
        : `pid file ${pidFilePath} does not exist`);
    } else {
      lines.push(`pid file ${pidFilePath} names pid ${pid}, which is ${isAlive(pid) ? 'alive' : 'not alive'}`);
    }
  }
  if (logPath) {
    const tail = readLogTail(logPath);
    lines.push(tail === null ? `server log ${logPath} could not be read` : `last lines of server log ${logPath}:\n${tail}`);
  }
  return lines;
};

// A server took longer than the old 30 s to listen once, with the whole suite sharing the machine. The
// longer budget covers that load. It is only a readiness wait, and every assertion stays as it was.
const waitForReady = async (port, { timeoutMs = 60_000, child = null, logPath = null, pidFilePath = null } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port);
    if (health?.body?.isOpenCodeReady === true) return health.body;
    await sleep(200);
  }
  const diagnostics = readinessDiagnostics({ child, logPath, pidFilePath });
  throw new Error([`server on ${port} did not become ready within ${timeoutMs}ms`, ...diagnostics].join('\n'));
};

const waitForExit = (child, timeoutMs = 15_000) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve(true);
    return;
  }
  const timer = setTimeout(() => resolve(false), timeoutMs);
  child.once('exit', () => {
    clearTimeout(timer);
    resolve(true);
  });
});

const waitForPidChange = async (file, fromPid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPid(file);
    if (pid !== null && pid !== fromPid && isAlive(pid)) return pid;
    await sleep(100);
  }
  return null;
};

const startServer = (sandbox, { port, name, env = {} }) => {
  const logPath = sandbox.logPath(name);
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [cliPath, 'serve', '--foreground', '--port', String(port), '--host', '127.0.0.1'], {
    env: { ...sandbox.env, ...env },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  return { child, logPath };
};

const runCli = (sandbox, args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cliPath, ...args], { env: { ...sandbox.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('exit', (code) => resolve({ code, stdout, stderr }));
});

// Keeps one keep-alive client polling /health every ~10 ms. A refused connection is the listener being
// closed with nothing accepting; any other error or non-200 answer is a failed request.
const startClient = (port) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const counts = { requests: 0, ok: 0, refused: 0, failed: 0, errors: {} };
  let running = true;
  const once = () => new Promise((resolve) => {
    counts.requests += 1;
    const request = http.get({ host: '127.0.0.1', port, path: '/health', agent, timeout: 3000 }, (response) => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode === 200) counts.ok += 1;
        else counts.failed += 1;
        resolve();
      });
      response.on('error', () => {
        counts.failed += 1;
        resolve();
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => {
      if (error.code === 'ECONNREFUSED') {
        counts.refused += 1;
      } else {
        counts.failed += 1;
        const key = error.code ?? error.message;
        counts.errors[key] = (counts.errors[key] ?? 0) + 1;
      }
      resolve();
    });
  });
  const loop = (async () => {
    while (running) {
      await once();
      await sleep(10);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      agent.destroy();
      return counts;
    },
  };
};

// Every fake OpenCode the sandbox started, not only the one state.json names last: when a handoff fails,
// the OpenCode it should have kept is no longer recorded and was left running after the test (12 orphans
// from one failing run, dezren39/nix#667). Only pids still running this sandbox's fake script are signalled.
const killRecordedOpenCode = (sandbox) => {
  const state = readJson(sandbox.statePath);
  const listed = (() => {
    try {
      return fs.readFileSync(path.join(sandbox.root, 'opencode-pids'), 'utf8').split('\n').map(Number);
    } catch {
      return [];
    }
  })();
  for (const pid of new Set([state?.pid, ...listed])) {
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? '';
    if (pid !== state?.pid && !command.includes(sandbox.root)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
};

// Full stop through the CLI (SIGINT), then SIGKILL for anything the test left behind. Only pids the
// test recorded inside its own sandbox are signalled.
const stopServers = async (sandbox, port, children) => {
  await runCli(sandbox, ['stop', '--port', String(port)]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  killRecordedOpenCode(sandbox);
};

const teardown = async (sandbox, port, children) => {
  await stopServers(sandbox, port, children);
  await fsp.rm(sandbox.root, { recursive: true, force: true });
};

// Readiness for one server start, with an early exit the plain waitForReady cannot make: when
// the child has already exited and its log says the bind failed, the port was taken between
// freePort releasing it and the child binding it, and waiting out the full readiness budget
// would only report that loss as a slow start. Any other dead child goes through the same
// diagnostics a readiness timeout reports, just without the wait.
const waitForReadyOrBindFailure = async (port, { timeoutMs = 60_000, child, logPath, pidFilePath }) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port);
    if (health?.body?.isOpenCodeReady === true) return health.body;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      const tail = logPath ? readLogTail(logPath) : null;
      if (tail && /EADDRINUSE|already in use/.test(tail)) {
        const error = new Error(`server on ${port} died because its port was already in use before it became ready, last lines of server log ${logPath}:\n${tail}`);
        error.bindFailure = true;
        throw error;
      }
      break;
    }
    await sleep(200);
  }
  const diagnostics = readinessDiagnostics({ child, logPath, pidFilePath });
  throw new Error([`server on ${port} did not become ready within ${timeoutMs}ms`, ...diagnostics].join('\n'));
};

// Starts a server in the sandbox and waits for readiness, retrying the whole start on a fresh
// port when the child dies on EADDRINUSE (#676). The port keys the CLI's pid file, state file
// and handoff arguments, so a retry cannot respawn one process the way #683 respawns the
// gatekeeper child: the failed attempt is stopped and the start sequence runs again. Bounded
// at five attempts; a fifth collision, and any non-collision failure, throws.
const startReadyServer = async (sandbox, { name, env = {} }) => {
  let lastBindError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const port = await freePort();
    const server = startServer(sandbox, { port, name, env });
    try {
      await waitForReadyOrBindFailure(port, { child: server.child, logPath: server.logPath, pidFilePath: sandbox.pidFilePath(port) });
      return { ...server, port };
    } catch (error) {
      if (!error.bindFailure) {
        await teardown(sandbox, port, [server.child]);
        throw error;
      }
      lastBindError = error;
      if (attempt === 5) {
        await teardown(sandbox, port, [server.child]);
        throw error;
      }
      await stopServers(sandbox, port, [server.child]);
    }
  }
  throw lastBindError;
};

const describeUnlessWindows = process.platform === 'win32' ? describe.skip : describe;

// Stands in for systemd's notify socket: prints each datagram on its own line, newlines escaped.
const notifyReceiverSource = `
import socket, sys
sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
sock.bind(sys.argv[1])
while True:
    print(sock.recv(65536).decode().replace("\\n", "\\\\n"), flush=True)
`;

const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasSystemdNotify = spawnSync('systemd-notify', ['--version']).status === 0;

const waitUntil = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await sleep(50);
  }
};

describeUnlessWindows('self-handoff across real processes', () => {
  let cleanups = [];

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups = [];
  });

  const track = (sandbox, port, children) => {
    cleanups.push(() => teardown(sandbox, port, children));
  };

  // (a) one run: a 10 ms client through `openchamber handoff`. Returns the counts and the pids.
  const runHandoffUnderLoad = async () => {
    const sandbox = await createSandbox();
    const predecessor = await startReadyServer(sandbox, { name: 'predecessor' });
    const port = predecessor.port;
    const children = [predecessor.child];
    track(sandbox, port, children);
    const pidFile = sandbox.pidFilePath(port);
    const oldPid = readPid(pidFile);
    const openCodeBefore = readJson(sandbox.statePath);

    const client = startClient(port);
    await sleep(500);
    const started = Date.now();
    const cli = await runCli(sandbox, ['handoff', '--port', String(port)]);
    const successorPid = await waitForPidChange(pidFile, oldPid, 40_000);
    const handoffMs = Date.now() - started;
    await sleep(500);
    const counts = await client.stop();
    const predecessorExited = await waitForExit(predecessor.child, 15_000);
    const openCodeAfter = readJson(sandbox.statePath);
    const health = await fetchHealth(port);
    const log = fs.readFileSync(predecessor.logPath, 'utf8');

    return { sandbox, port, cli, oldPid, successorPid, handoffMs, counts, predecessorExited, openCodeBefore, openCodeAfter, health, log };
  };

  it('hands the listener to a successor with no refused connection and no failed request', async () => {
    const run = await runHandoffUnderLoad();
    report({ run: 'handoff', handoffMs: run.handoffMs, ...run.counts, oldPid: run.oldPid, successorPid: run.successorPid });

    expect(run.cli.code).toBe(0);
    expect(run.successorPid).not.toBeNull();
    expect(run.successorPid).not.toBe(run.oldPid);
    expect(run.predecessorExited).toBe(true);
    expect(run.counts.requests).toBeGreaterThan(20);
    expect(run.counts.refused).toBe(0);
    expect(run.counts.failed).toBe(0);
    expect(run.counts.ok).toBe(run.counts.requests);
  }, 120_000);

  // Ten independent runs, so one lucky timing cannot pass the zero-refused claim.
  for (let runNumber = 1; runNumber <= 10; runNumber += 1) {
    it(`loop run ${runNumber}/10: zero refused, zero failed`, async () => {
      const run = await runHandoffUnderLoad();
      report({ run: runNumber, handoffMs: run.handoffMs, requests: run.counts.requests, ok: run.counts.ok, refused: run.counts.refused, failed: run.counts.failed, errors: run.counts.errors });
      expect(run.successorPid).not.toBeNull();
      expect(run.counts.refused).toBe(0);
      expect(run.counts.failed).toBe(0);
    }, 120_000);
  }

  // The readiness timeout must carry the evidence — server log tail, child exit state and pid-file
  // state — so a CI recurrence says whether the server crashed, hung, or was merely slow (#131).
  it('readiness timeout names the log tail, the exited child and the pid file', async () => {
    const sandbox = await createSandbox();
    cleanups.push(() => fsp.rm(sandbox.root, { recursive: true, force: true }));
    const port = await freePort();
    const logPath = sandbox.logPath('never-ready');
    await fsp.writeFile(logPath, 'starting up\nmanaged launch: start\nstartup stalled marker\n');
    const child = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
    await waitForExit(child, 15_000);
    const pidFile = sandbox.pidFilePath(port);
    await fsp.mkdir(path.dirname(pidFile), { recursive: true });
    await fsp.writeFile(pidFile, `${child.pid}\n`);

    const error = await waitForReady(port, { timeoutMs: 300, child, logPath, pidFilePath: pidFile }).then(
      () => null,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`server on ${port} did not become ready within 300ms`);
    expect(error.message).toContain('startup stalled marker');
    expect(error.message).toContain(`server process ${child.pid} has exited (exit code 3`);
    expect(error.message).toContain(`names pid ${child.pid}, which is not alive`);
  }, 30_000);

  it('readiness timeout reports a still-running child and missing log and pid file', async () => {
    const sandbox = await createSandbox();
    cleanups.push(() => fsp.rm(sandbox.root, { recursive: true, force: true }));
    const port = await freePort();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    cleanups.push(async () => child.kill('SIGKILL'));

    const error = await waitForReady(port, {
      timeoutMs: 300,
      child,
      logPath: sandbox.logPath('missing'),
      pidFilePath: sandbox.pidFilePath(port),
    }).then(() => null, (caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`server process ${child.pid} is still running`);
    expect(error.message).toContain('could not be read');
    expect(error.message).toContain('does not exist');
  }, 30_000);

  // (b) the managed OpenCode child keeps its pid and port across the handoff; the successor adopts it.
  it('keeps the OpenCode child on the same pid and port across the handoff', async () => {
    const run = await runHandoffUnderLoad();
    expect(run.openCodeBefore?.pid).toBeGreaterThan(0);
    expect(run.openCodeAfter?.pid).toBe(run.openCodeBefore.pid);
    expect(run.openCodeAfter?.port).toBe(run.openCodeBefore.port);
    expect(isAlive(run.openCodeBefore.pid)).toBe(true);
    expect(run.health?.body?.openCodePort).toBe(run.openCodeBefore.port);
    // The predecessor's own startup logs "start"; the successor's launch decision comes after the handoff line.
    const successorLog = run.log.slice(run.log.indexOf('[handoff] starting successor'));
    expect(successorLog).toMatch(/managed launch: adopt \(matches-state\)/);
    expect(successorLog).not.toMatch(/managed launch: (start|handoff|replace)/);
  }, 120_000);

  // (c) the successor never reports ready. The predecessor keeps serving, the successor is killed, and the
  // pid files stay the predecessor's.
  it('keeps the old process serving when the successor is not ready in time', async () => {
    const sandbox = await createSandbox();
    const env = { OPENCHAMBER_HANDOFF_TIMEOUT_MS: '1' };
    const predecessor = await startReadyServer(sandbox, { name: 'predecessor', env });
    const port = predecessor.port;
    const children = [predecessor.child];
    track(sandbox, port, children);
    const pidFile = sandbox.pidFilePath(port);
    const oldPid = readPid(pidFile);
    const openCodeBefore = readJson(sandbox.statePath);

    const client = startClient(port);
    await sleep(500);
    const cli = await runCli(sandbox, ['handoff', '--port', String(port)], env);
    await sleep(500);
    const counts = await client.stop();

    const log = fs.readFileSync(predecessor.logPath, 'utf8');
    const successorPid = Number(log.match(/starting successor (\d+) on port/)?.[1]);
    report({ run: 'not-ready', cliCode: cli.code, requests: counts.requests, ok: counts.ok, refused: counts.refused, failed: counts.failed, successorPid });

    expect(cli.code).not.toBe(0);
    expect(log).toMatch(/successor did not become ready \(timeout\); still serving/);
    expect(predecessor.child.exitCode).toBeNull();
    expect(isAlive(oldPid)).toBe(true);
    expect(readPid(pidFile)).toBe(oldPid);
    expect(successorPid).toBeGreaterThan(0);
    expect(isAlive(successorPid)).toBe(false);
    expect(readJson(sandbox.statePath)?.pid).toBe(openCodeBefore.pid);
    expect(counts.requests).toBeGreaterThan(20);
    expect(counts.refused).toBe(0);
    expect(counts.failed).toBe(0);
  }, 120_000);

  // (d) negative control: handoff disabled. The old process stops, then a new one starts, which is what
  // `systemctl restart` does without socket activation. The same client must see refused connections.
  it('shows refused connections when the restart stops the old process before the new one listens', async () => {
    const sandbox = await createSandbox();
    const env = { OPENCHAMBER_SELF_HANDOFF: '0' };
    const predecessor = await startReadyServer(sandbox, { name: 'predecessor', env });
    const port = predecessor.port;
    const children = [predecessor.child];
    track(sandbox, port, children);
    const pidFile = sandbox.pidFilePath(port);

    const refused = await runCli(sandbox, ['handoff', '--port', String(port)], env);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/Self-handoff is disabled/);

    const client = startClient(port);
    await sleep(500);
    predecessor.child.kill('SIGTERM');
    await waitForExit(predecessor.child, 15_000);
    const successor = startServer(sandbox, { port, name: 'successor', env });
    children.push(successor.child);
    await waitForReady(port, { child: successor.child, logPath: successor.logPath, pidFilePath: pidFile });
    await sleep(500);
    const counts = await client.stop();
    report({ run: 'negative-control', requests: counts.requests, ok: counts.ok, refused: counts.refused, failed: counts.failed, errors: counts.errors });

    expect(counts.refused).toBeGreaterThan(0);
  }, 120_000);

  // (e) under systemd: the successor's readiness goes to $NOTIFY_SOCKET as READY=1 with its own main pid,
  // which is what lets the unit keep running when the old process exits.
  it.skipIf(!hasPython || !hasSystemdNotify)('tells systemd the successor is ready and is the main pid', async () => {
    const sandbox = await createSandbox();
    const notifySocket = path.join(sandbox.root, 'notify.sock');
    const receiver = spawn('python3', ['-u', '-c', notifyReceiverSource, notifySocket], { stdio: ['ignore', 'pipe', 'inherit'] });
    cleanups.push(async () => receiver.kill('SIGKILL'));
    const datagrams = [];
    readline.createInterface({ input: receiver.stdout }).on('line', (line) => datagrams.push(line));
    await waitUntil(() => fs.existsSync(notifySocket));

    const predecessor = await startReadyServer(sandbox, { name: 'predecessor', env: { NOTIFY_SOCKET: notifySocket } });
    const port = predecessor.port;
    track(sandbox, port, [predecessor.child]);
    const pidFile = sandbox.pidFilePath(port);
    const oldPid = readPid(pidFile);

    const cli = await runCli(sandbox, ['handoff', '--port', String(port)]);
    const successorPid = await waitForPidChange(pidFile, oldPid, 40_000);
    const predecessorExited = await waitForExit(predecessor.child, 15_000);
    await waitUntil(() => datagrams.some((line) => line.includes(`MAINPID=${successorPid}`)), 10_000);

    expect(cli.code).toBe(0);
    expect(predecessorExited).toBe(true);
    const ready = datagrams.find((line) => line.includes(`MAINPID=${successorPid}`));
    expect(ready).toMatch(/READY=1/);
  }, 120_000);
});
