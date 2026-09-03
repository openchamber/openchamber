#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import { afterEach, test } from 'node:test';

import { GuardianClient } from './guardian-client.js';
import { GuardianIpcServer } from './ipc-server.js';
import {
  createIpcServer,
  recoverStaleGuardianTransportArtifacts,
} from './ipc-transport.js';
import { snapshotFileIdentity } from './file-identity.js';
import {
  compareProcessIdentity,
  probeProcessLiveness,
  readProcessIdentity,
} from './process-identity.js';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22 || process.versions.bun) {
  throw new Error('ipc-transport.boundary.mjs requires Node.js >=22 and is not Bun-compatible');
}

const HELPER_PATH = new URL('./ipc-listener-helper.js', import.meta.url);
const roots = [];
const trackedChildren = new Set();
const trackedServers = new Set();
const trackedTransports = new Set();
const trackedReplacementProcesses = new Map();
const RESOURCE_CLEANUP_TIMEOUT_MS = 2_000;

const makeRoot = (label) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openchamber-${label}-`));
  roots.push(root);
  return root;
};

const waitForExit = (child, timeoutMs = RESOURCE_CLEANUP_TIMEOUT_MS) => new Promise((resolve, reject) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve({ code: child.exitCode, signal: child.signalCode });
    return;
  }

  let timer;
  const onExit = (code, signal) => {
    child.off('exit', onExit);
    clearTimeout(timer);
    resolve({ code, signal });
  };
  timer = setTimeout(() => {
    child.off('exit', onExit);
    const error = new Error(`tracked child did not exit within ${timeoutMs}ms`);
    error.code = 'BOUNDARY_CHILD_EXIT_TIMEOUT';
    reject(error);
  }, timeoutMs);
  child.once('exit', onExit);

  // The child can exit between the initial check and listener registration.
  if (child.exitCode !== null || child.signalCode !== null) {
    onExit(child.exitCode, child.signalCode);
  }
});

const trackChild = (child) => {
  trackedChildren.add(child);
  const untrack = () => trackedChildren.delete(child);
  child.once('exit', untrack);
  child.once('close', untrack);
  return child;
};

const waitForExitWithin = async (child, timeoutMs = RESOURCE_CLEANUP_TIMEOUT_MS) => {
  try {
    await waitForExit(child, timeoutMs);
    return true;
  } catch (error) {
    if (error?.code === 'BOUNDARY_CHILD_EXIT_TIMEOUT') return false;
    throw error;
  }
};

const terminateChild = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const failures = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      const sent = child.kill(signal);
      if (!sent && child.exitCode === null && child.signalCode === null) {
        failures.push(new Error(`child.kill(${signal}) returned false`));
      }
    } catch (error) {
      if (error?.code !== 'ESRCH' && child.exitCode === null && child.signalCode === null) {
        failures.push(error);
      }
    }
    if (await waitForExitWithin(child)) {
      if (failures.length > 0) {
        throw new AggregateError(failures, 'tracked child signal failed after exit race');
      }
      return;
    }
  }

  const unresolved = new Error('tracked child did not exit after bounded TERM/KILL cleanup');
  if (failures.length > 0) unresolved.cause = new AggregateError(failures, 'child signal failures');
  throw unresolved;
};

const trackServer = (server) => {
  trackedServers.add(server);
  server.once('close', () => trackedServers.delete(server));
  return server;
};

const closeServer = async (server) => {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  let timer;
  const closed = new Promise((resolve, reject) => {
    try {
      server.close((error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('tracked server close timed out')), RESOURCE_CLEANUP_TIMEOUT_MS);
  });
  try {
    await Promise.race([closed, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const trackReplacementProcess = (pidPath, expectedCommand, expectedCwd = process.cwd()) => {
  trackedReplacementProcesses.set(pidPath, {
    expectedCommand,
    expectedCwd,
    child: null,
    pid: null,
    identity: null,
  });
};

const createTrackedIpcServer = (options) => {
  const transport = createIpcServer(options);
  trackedTransports.add(transport);
  return transport;
};

// Expected fail-closed close assertions have already awaited the transport's
// helper shutdown. Only then may a test release that transport from the
// teardown tracker; any remaining child/server tracker still blocks root
// removal and reports unresolved cleanup.
const acknowledgeExpectedTransportFailure = (transport) => {
  trackedTransports.delete(transport);
};

const replacementProcessMatches = (pid, entry) => {
  const identity = readProcessIdentity(pid);
  if (!identity || !identity.launch?.commandLine) return false;
  if (entry.identity && compareProcessIdentity(entry.identity, identity) !== null) return false;
  return identity.launch.commandLine.includes('--input-type=module')
    && identity.launch.commandLine.includes(entry.expectedCommand)
    && path.resolve(identity.launch.cwd || '') === path.resolve(entry.expectedCwd)
    && (entry.identity?.owner === null
      || entry.identity?.owner === undefined
      || identity.owner === entry.identity.owner);
};

const captureReplacementProcessIdentity = (pidPath, entry) => {
  const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
  const identity = readProcessIdentity(pid);
  if (!identity || !replacementProcessMatches(pid, { ...entry, identity: null })) {
    throw new Error(`replacement listener identity could not be captured for pid ${pid}`);
  }
  entry.pid = pid;
  entry.identity = identity;
};

const waitForReplacementProcessExit = async (pid, entry) => {
  const deadline = Date.now() + RESOURCE_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const liveness = probeProcessLiveness(pid);
    if (liveness === 'dead') return true;
    if (liveness !== 'alive') return false;
    const identity = readProcessIdentity(pid);
    if (!identity) return false;
    if (entry.identity && compareProcessIdentity(entry.identity, identity) !== null) return true;
    if (!replacementProcessMatches(pid, entry)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const liveness = probeProcessLiveness(pid);
  if (liveness === 'dead') return true;
  if (liveness !== 'alive') return false;
  const identity = readProcessIdentity(pid);
  return Boolean(identity && entry.identity
    && compareProcessIdentity(entry.identity, identity) !== null);
};

const terminateReplacementProcess = async (pidPath, entry) => {
  let pid;
  try { pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8'), 10); } catch (error) {
    if (error?.code === 'ENOENT') {
      // A missing tracker is not proof that the replacement exited. A direct
      // child handle is authoritative only after it reports exit; a detached
      // replacement can use its previously captured PID/start identity to
      // prove that the original process is gone. Otherwise retain the entry
      // and temp root for diagnosis rather than clearing live authority.
      if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null) {
        const unresolved = new Error(`replacement listener pid tracker is missing while its tracked child remains alive: ${pidPath}`);
        unresolved.code = 'BOUNDARY_REPLACEMENT_TRACKER_MISSING';
        throw unresolved;
      }
      if (entry.child) return;
      if (!Number.isSafeInteger(entry.pid) || entry.pid <= 1 || !entry.identity) {
        const unresolved = new Error(`replacement listener pid tracker is missing before exit identity was captured: ${pidPath}`);
        unresolved.code = 'BOUNDARY_REPLACEMENT_TRACKER_MISSING';
        throw unresolved;
      }
      const liveness = probeProcessLiveness(entry.pid);
      if (liveness === 'dead') return;
      if (liveness !== 'alive') {
        const unresolved = new Error(`replacement listener pid tracker is missing and pid ${entry.pid} liveness is ambiguous`);
        unresolved.code = 'BOUNDARY_REPLACEMENT_TRACKER_MISSING';
        throw unresolved;
      }
      const identity = readProcessIdentity(entry.pid);
      if (!identity) {
        const unresolved = new Error(`replacement listener pid tracker is missing and pid ${entry.pid} identity is unavailable`);
        unresolved.code = 'BOUNDARY_REPLACEMENT_TRACKER_MISSING';
        throw unresolved;
      }
      if (compareProcessIdentity(entry.identity, identity) !== null) return;
      const unresolved = new Error(`replacement listener pid tracker is missing while pid ${entry.pid} remains alive: ${pidPath}`);
      unresolved.code = 'BOUNDARY_REPLACEMENT_TRACKER_MISSING';
      throw unresolved;
    }
    throw error;
  }
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error(`invalid tracked replacement listener pid in ${pidPath}`);
  }
  if (!entry.identity) captureReplacementProcessIdentity(pidPath, entry);
  const initialLiveness = probeProcessLiveness(pid);
  if (initialLiveness === 'dead') return;
  if (initialLiveness !== 'alive') {
    throw new Error(`replacement listener pid ${pid} liveness is ambiguous`);
  }
  const initialIdentity = readProcessIdentity(pid);
  if (!initialIdentity) {
    throw new Error(`replacement listener pid ${pid} identity is unavailable`);
  }
  if (entry.identity && compareProcessIdentity(entry.identity, initialIdentity) !== null) return;
  if (!replacementProcessMatches(pid, entry)) return;

  const failures = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (probeProcessLiveness(pid) !== 'dead') failures.push(error);
    }
    if (await waitForReplacementProcessExit(pid, entry)) {
      if (failures.length > 0) {
        throw new AggregateError(failures, 'replacement listener signal failed after exit race');
      }
      return;
    }
  }

  const unresolved = new Error(`replacement listener pid ${pid} did not exit after bounded TERM/KILL cleanup`);
  if (failures.length > 0) unresolved.cause = new AggregateError(failures, 'replacement signal failures');
  throw unresolved;
};

const cleanupTrackedResources = async () => {
  const errors = [];
  // Replacement listeners are deliberately kept alive through the assertions.
  // Once the test body is done, terminate and prove them gone before retrying
  // identity-fenced transport cleanup.
  for (const [pidPath, entry] of [...trackedReplacementProcesses]) {
    try {
      await terminateReplacementProcess(pidPath, entry);
      trackedReplacementProcesses.delete(pidPath);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const server of [...trackedServers]) {
    try {
      await closeServer(server);
      trackedServers.delete(server);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const transport of [...trackedTransports]) {
    try {
      await transport.close();
      trackedTransports.delete(transport);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const child of [...trackedChildren]) {
    try { await terminateChild(child); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `tracked process-boundary cleanup failed: ${errors.map((error) => error?.message || String(error)).join('; ')}`,
    );
  }
};

const startHelper = async (socketPath) => {
  const child = trackChild(fork(HELPER_PATH, [], {
    env: {},
    execArgv: [],
    execPath: process.execPath,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }));
  await new Promise((resolve, reject) => {
    let tokenHandle = null;
    let tokenBuffer = '';
    const tokenMarker = (token) => `guardian-ipc-publication-handle:${token}\n`;
    const tokenAccept = (token) => `guardian-ipc-publication-accept:${token}\n`;
    const tokenCommit = (token) => `guardian-ipc-publication-commit:${token}\n`;
    const tokenCommitAck = (token) => `guardian-ipc-publication-commit-ack:${token}\n`;
    const tokenCommitConfirm = (token) => `guardian-ipc-publication-commit-confirm:${token}\n`;
    child.on('message', (message) => {
      if (message?.type === 'ready') {
        assert.equal(typeof message.publicationToken, 'string');
        assert.equal(message.publicationProof?.token, message.publicationToken);
        assert.ok(message.handleIdentity?.descriptorIdentity);
        assert.ok(message.handleIdentity?.listenerIdentity);
        assert.deepEqual(
          message.handleIdentity.descriptorIdentity,
          message.handleIdentity.publicIdentity,
        );
        assert.deepEqual(
          message.handleIdentity.descriptorIdentity,
          message.handleIdentity.ownerIdentity,
        );
        assert.deepEqual(
          message.handleIdentity.boundPathIdentity,
          message.handleIdentity.ownerIdentity,
        );
        assert.deepEqual(message.identity, message.handleIdentity.descriptorIdentity);
        assert.deepEqual(message.publicIdentity, message.handleIdentity.publicIdentity);
        assert.deepEqual(message.ownerIdentity, message.handleIdentity.ownerIdentity);
        const onCommit = (chunk) => {
          tokenBuffer += chunk.toString();
          if (tokenBuffer.includes(tokenCommit(message.publicationToken))) {
            tokenBuffer = '';
            tokenHandle.off('data', onCommit);
            const onConfirm = (confirmChunk) => {
              tokenBuffer += confirmChunk.toString();
              if (!tokenBuffer.includes(tokenCommitConfirm(message.publicationToken))) return;
              tokenHandle.destroy();
              resolve();
            };
            tokenHandle.on('data', onConfirm);
            tokenHandle.write(tokenCommitAck(message.publicationToken));
          }
        };
        tokenHandle.on('data', onCommit);
        tokenHandle.resume();
        tokenHandle.write(tokenAccept(message.publicationToken));
      } else if (message?.type === 'error') {
        reject(new Error(`helper failed: ${message.code || 'unknown'}`));
      }
    });
    child.on('message', (message, handle) => {
      if (message?.type !== 'ready-candidate') return;
      tokenHandle = handle;
      const onCandidateData = (chunk) => {
        tokenBuffer += chunk.toString();
        if (!tokenBuffer.includes(tokenMarker(message.publicationToken))) return;
        tokenBuffer = '';
        tokenHandle.off('data', onCandidateData);
        tokenHandle.pause();
        child.send({
          type: 'accept-ready',
          publicationToken: message.publicationToken,
        });
      };
      tokenHandle.on('data', onCandidateData);
      tokenHandle.resume();
      child.send({
        type: 'publication-handle-ready',
        publicationToken: message.publicationToken,
      });
    });
    child.once('error', reject);
    child.send({ type: 'listen', socketPath });
  });
  return child;
};

const startHelperAndDisconnectBeforeReady = async (socketPath) => {
  const child = trackChild(fork(HELPER_PATH, [], {
    env: {},
    execArgv: [],
    execPath: process.execPath,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.send({ type: 'listen', socketPath }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        child.disconnect();
        resolve();
      } catch (disconnectError) {
        reject(disconnectError);
      }
    });
  });
  await waitForExit(child);
};

const writeReadyIdentityMismatchHelper = (helperPath) => {
  const fileIdentityModule = new URL('./file-identity.js', import.meta.url).href;
  fs.writeFileSync(helperPath, `
    import fs from 'node:fs';
    import net from 'node:net';
    import { snapshotFileIdentity } from ${JSON.stringify(fileIdentityModule)};

    process.on('message', (message) => {
      if (message?.type === 'shutdown') {
        process.exit(0);
        return;
      }
      if (message?.type !== 'listen') return;
      const server = net.createServer();
      server.listen(message.socketPath, () => {
        fs.chmodSync(message.socketPath, 0o600);
        fs.linkSync(message.socketPath, message.socketPath + '.owner');
        const publicIdentity = snapshotFileIdentity(fs.lstatSync(message.socketPath));
        const ownerIdentity = snapshotFileIdentity(fs.lstatSync(message.socketPath + '.owner'));
        const descriptorIdentity = {
          ...publicIdentity,
          ...(publicIdentity.birthtime !== null
            ? { birthtime: publicIdentity.birthtime + ':replacement' }
            : { ctime: publicIdentity.ctime + ':replacement' }),
        };
        process.send({
          type: 'ready',
          identity: publicIdentity,
           handleIdentity: {
             boundPathIdentity: ownerIdentity,
             descriptorIdentity,
             publicIdentity,
             ownerIdentity,
           },
          publicIdentity,
          ownerIdentity,
        });
      });
    });
  `, 'utf8');
};

const writeBindToAliasReplacementHelper = (helperPath) => {
  const helperModule = HELPER_PATH.href;
  fs.writeFileSync(helperPath, `
    import fs from 'node:fs';
    let replaced = false;
    const realLstatSync = fs.lstatSync.bind(fs);
    fs.lstatSync = (target, ...args) => {
      const stat = realLstatSync(target, ...args);
      if (!replaced && typeof target === 'string' && target.endsWith('guardian.sock')) {
        replaced = true;
        fs.unlinkSync(target);
        fs.writeFileSync(target, 'replacement-between-bind-and-alias', 'utf8');
      }
      return stat;
    };
    await import(${JSON.stringify(helperModule)});
  `, 'utf8');
};

const writeOwnerPathReplacementHelper = (
  helperPath,
  ownerPath,
  readyPath,
  countPath,
  replacementPidPath,
) => {
  const helperModule = HELPER_PATH.href;
  const replacementScript = [
    'import fs from "node:fs";',
    'import net from "node:net";',
    `const ownerPath = ${JSON.stringify(ownerPath)};`,
    `const readyPath = ${JSON.stringify(readyPath)};`,
    `const countPath = ${JSON.stringify(countPath)};`,
    `const replacementPidPath = ${JSON.stringify(replacementPidPath)};`,
    'let server;',
    'let shuttingDown = false;',
    'const sockets = new Set();',
    'const closeReplacement = () => {',
    '  if (shuttingDown) return;',
    '  shuttingDown = true;',
    '  for (const socket of sockets) socket.destroy();',
    '  if (!server?.listening) { process.exit(0); return; }',
    '  server.close(() => process.exit(0));',
    '};',
    'process.once("SIGTERM", closeReplacement);',
    'process.once("SIGINT", closeReplacement);',
    'const createReplacementServer = () => net.createServer((socket) => {',
    '  sockets.add(socket);',
    '  socket.once("close", () => sockets.delete(socket));',
    '  const current = Number(fs.readFileSync(countPath, "utf8") || "0") + 1;',
    '  fs.writeFileSync(countPath, String(current));',
    '  socket.on("data", () => {});',
    '});',
    'server = createReplacementServer();',
    'server.once("error", () => process.exit(1));',
    'fs.writeFileSync(replacementPidPath, String(process.pid));',
    'server.listen(ownerPath, () => { fs.writeFileSync(readyPath, "ready"); fs.writeFileSync(countPath, "0"); });',
  ].join('\n');
  fs.writeFileSync(helperPath, `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    const replacementScript = ${JSON.stringify(replacementScript)};
    const realOpenSync = fs.openSync.bind(fs);
    let replaced = false;
    let replacementChild = null;
    fs.openSync = (target, flags, ...args) => {
      if (
        !replaced
        && typeof target === 'string'
        && target === ${JSON.stringify(ownerPath)}
        && (flags & 0x200000) !== 0
      ) {
        replaced = true;
        fs.unlinkSync(target);
        replacementChild = spawn(process.execPath, ['--input-type=module', '-e', replacementScript], {
          stdio: 'ignore',
        });
        const waitStarted = Date.now();
        while (!fs.existsSync(${JSON.stringify(readyPath)})) {
          if (Date.now() - waitStarted > 2_000) throw new Error('replacement socket did not bind');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return realOpenSync(target, flags, ...args);
    };
    await import(${JSON.stringify(helperModule)});
  `, 'utf8');
};

const writeReadyDeliveryReplacementHelper = (
  helperPath,
  socketPath,
  ownerPath,
  readyPath,
  countPath,
) => {
  const helperModule = HELPER_PATH.href;
  fs.writeFileSync(helperPath, `
    import fs from 'node:fs';
    import net from 'node:net';
    const socketPath = ${JSON.stringify(socketPath)};
    const ownerPath = ${JSON.stringify(ownerPath)};
    const readyPath = ${JSON.stringify(readyPath)};
    const countPath = ${JSON.stringify(countPath)};
    const realSend = process.send.bind(process);
    let replaced = false;
    let replacementServer = null;

    process.send = (message, handle, callback) => {
      if (message?.type !== 'ready' || replaced) {
        return handle === undefined
          ? realSend(message, callback)
          : realSend(message, handle, callback);
      }

      replaced = true;
      fs.unlinkSync(socketPath);
      fs.unlinkSync(ownerPath);
      replacementServer = net.createServer((socket) => {
        const count = Number(fs.readFileSync(countPath, 'utf8') || '0') + 1;
        fs.writeFileSync(countPath, String(count));
        socket.resume();
      });
      replacementServer.listen(ownerPath, () => {
        fs.linkSync(ownerPath, socketPath);
        fs.writeFileSync(readyPath, 'ready');
        realSend(message, handle, callback);
      });
      return true;
    };

    await import(${JSON.stringify(helperModule)});
  `, 'utf8');
};

const writeCommitDeliveryReplacementHelper = (
  helperPath,
  socketPath,
  ownerPath,
  readyPath,
  countPath,
  replacementPidPath,
) => {
  const helperModule = HELPER_PATH.href;
  const replacementScript = [
    'import fs from "node:fs";',
    'import net from "node:net";',
    `const socketPath = ${JSON.stringify(socketPath)};`,
    `const ownerPath = ${JSON.stringify(ownerPath)};`,
    `const readyPath = ${JSON.stringify(readyPath)};`,
    `const countPath = ${JSON.stringify(countPath)};`,
    `const replacementPidPath = ${JSON.stringify(replacementPidPath)};`,
    'const sockets = new Set();',
    'let shuttingDown = false;',
    'const server = net.createServer((socket) => {',
    '  sockets.add(socket);',
    '  socket.once("close", () => sockets.delete(socket));',
    '  const count = Number(fs.readFileSync(countPath, "utf8") || "0") + 1;',
    '  fs.writeFileSync(countPath, String(count));',
    '  socket.on("data", () => {});',
    '});',
    'const closeReplacement = () => {',
    '  if (shuttingDown) return;',
    '  shuttingDown = true;',
    '  for (const socket of sockets) socket.destroy();',
    '  server.close(() => process.exit(0));',
    '};',
    'process.once("SIGTERM", closeReplacement);',
    'process.once("SIGINT", closeReplacement);',
    'fs.writeFileSync(replacementPidPath, String(process.pid));',
    'fs.writeFileSync(countPath, "0");',
    'server.listen(ownerPath, () => {',
    '  fs.linkSync(ownerPath, socketPath);',
    '  fs.writeFileSync(readyPath, "ready");',
    '});',
    'setInterval(() => {}, 1000);',
  ].join('\n');

  fs.writeFileSync(helperPath, `
    import fs from 'node:fs';
    import net from 'node:net';
    import { spawn } from 'node:child_process';
    const socketPath = ${JSON.stringify(socketPath)};
    const ownerPath = ${JSON.stringify(ownerPath)};
    const readyPath = ${JSON.stringify(readyPath)};
    const replacementScript = ${JSON.stringify(replacementScript)};
    const realWrite = net.Socket.prototype.write;
    let replaced = false;
    let replacementChild = null;

    net.Socket.prototype.write = function patchedWrite(chunk, ...args) {
      if (
        !replaced
        && typeof chunk === 'string'
        && chunk.includes('guardian-ipc-publication-commit:')
      ) {
        replaced = true;
        fs.unlinkSync(socketPath);
        fs.unlinkSync(ownerPath);
        replacementChild = spawn(process.execPath, ['--input-type=module', '-e', replacementScript], {
          stdio: 'ignore',
        });
        const waitStarted = Date.now();
        while (!fs.existsSync(readyPath)) {
          if (Date.now() - waitStarted > 2_000) throw new Error('replacement socket did not bind');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return realWrite.call(this, chunk, ...args);
    };

    await import(${JSON.stringify(helperModule)});
  `, 'utf8');
};

const startReplacementListenerSynchronously = (
  socketPath,
  ownerPath,
  readyPath,
  countPath,
  replacementPidPath = null,
) => {
  const replacementScript = [
    'import fs from "node:fs";',
    'import net from "node:net";',
    `const socketPath = ${JSON.stringify(socketPath)};`,
    `const ownerPath = ${JSON.stringify(ownerPath)};`,
    `const readyPath = ${JSON.stringify(readyPath)};`,
    `const countPath = ${JSON.stringify(countPath)};`,
    'const server = net.createServer((socket) => {',
    '  const count = Number(fs.readFileSync(countPath, "utf8") || "0") + 1;',
    '  fs.writeFileSync(countPath, String(count));',
    '  socket.on("data", () => {});',
    '});',
    'fs.writeFileSync(countPath, "0");',
    'process.once("SIGTERM", () => server.close(() => process.exit(0)));',
    'server.listen(ownerPath, () => {',
    '  fs.linkSync(ownerPath, socketPath);',
    '  fs.writeFileSync(readyPath, "ready");',
    '});',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = trackChild(spawn(process.execPath, ['--input-type=module', '-e', replacementScript], {
    stdio: 'ignore',
  }));
  const waitStarted = Date.now();
  while (!fs.existsSync(readyPath)) {
    if (Date.now() - waitStarted > 2_000) {
      try {
        if (!child.kill('SIGKILL')) {
          throw new Error('replacement listener SIGKILL was not accepted');
        }
      } catch (error) {
        throw new Error('replacement listener cleanup failed after startup timeout', { cause: error });
      }
      throw new Error('replacement listener did not publish its pair');
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  const replacementEntry = replacementPidPath
    ? trackedReplacementProcesses.get(replacementPidPath)
    : null;
  if (replacementEntry) {
    replacementEntry.child = child;
    captureReplacementProcessIdentity(replacementPidPath, replacementEntry);
  }
  return child;
};

const writeUnannouncedCleanupFailureHelper = (helperPath, candidatePath) => {
  const helperModule = HELPER_PATH.href;
  fs.writeFileSync(helperPath, `
    import fs from 'node:fs';
    const candidatePath = ${JSON.stringify(candidatePath)};
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const realSend = process.send.bind(process);

    fs.unlinkSync = (target, ...args) => {
      if (typeof target === 'string' && target.endsWith('.remove')) {
        fs.writeFileSync(candidatePath, 'cleanup-attempted');
        throw Object.assign(new Error('helper quarantine unlink denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    };

    process.send = (message, ...args) => {
      if (message?.type === 'ready-candidate') {
        fs.writeFileSync(candidatePath, 'ready-candidate');
        return true;
      }
      return realSend(message, ...args);
    };

    await import(${JSON.stringify(helperModule)});
  `, 'utf8');
};

const staleMarker = (root, token, socketPath) => ({
  status: 'valid',
  token,
  pid: 42420,
  identity: {
    processStartTicks: '10',
    launch: { commandLine: 'node openchamber-guardian.js', cwd: root },
    owner: '1000',
  },
  transportIdentity: {
    publicIdentity: snapshotFileIdentity(fs.lstatSync(socketPath)),
    ownerIdentity: snapshotFileIdentity(fs.lstatSync(`${socketPath}.owner`)),
  },
});

const cleanupRoots = () => {
  const errors = [];
  while (roots.length > 0) {
    const root = roots[roots.length - 1];
    try {
      fs.rmSync(root, { recursive: true, force: true });
      roots.pop();
    } catch (error) {
      errors.push(error);
      break;
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'process-boundary temp-root cleanup failed');
};

afterEach(async () => {
  await cleanupTrackedResources();
  cleanupRoots();
});

test('authenticated guardian IPC uses a helper-forwarded real socket', async () => {
  const root = makeRoot('guardian-helper-auth');
  const socketPath = path.join(root, 'guardian.sock');
  const secret = Buffer.alloc(32, 7);
  const guardian = {
    spawnManagedOpenCode: async () => ({}),
    stopChild: async () => ({}),
    healthCheckForOwner: async () => ({ healthy: true }),
    getCredential: async () => null,
    prepareHandoff: async () => ({}),
    abortHandoff: async () => ({}),
    reload: async () => ({}),
    listChildren: async () => [],
    stop: async () => {},
  };
  const server = new GuardianIpcServer({
    platform: 'linux',
    socketPath,
    guardian,
    authSecret: secret,
    log: () => {},
  });
  const client = new GuardianClient({ socketPath, authSecret: secret });

  await server.start();
  try {
    await client.connect();
    assert.deepEqual(await client.list(), []);
  } finally {
    client.disconnect();
    await server.stop();
  }
});

test('replacement before, during, and after helper shutdown is never unlinked', async () => {
  const closeWithReplacement = async (label, replaceBeforeClose) => {
    const root = makeRoot(`guardian-helper-replacement-${label}`);
    const socketPath = path.join(root, 'guardian.sock');
    const transport = createTrackedIpcServer({ platform: 'linux', socketPath, log: () => {} });
    await transport.listen({ onRequest: () => {} });

    if (replaceBeforeClose) {
      fs.unlinkSync(socketPath);
      fs.writeFileSync(socketPath, `replacement-${label}`);
    }

    let originalLstat = null;
    let replaced = replaceBeforeClose;
    if (!replaceBeforeClose) {
      originalLstat = fs.lstatSync;
      fs.lstatSync = function patchedLstat(target, ...args) {
        if (target === socketPath && !replaced) {
          replaced = true;
          fs.unlinkSync(socketPath);
          fs.writeFileSync(socketPath, `replacement-${label}`);
        }
        return originalLstat.call(this, target, ...args);
      };
    }

    try {
      await assert.rejects(transport.close(), {
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        artifact: 'POSIX guardian socket',
      });
      assert.equal(fs.readFileSync(socketPath, 'utf8'), `replacement-${label}`);
    } finally {
      if (originalLstat) fs.lstatSync = originalLstat;
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
    }
     await assert.rejects(transport.close(), {
       code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
     });
     acknowledgeExpectedTransportFailure(transport);
  };

  await closeWithReplacement('before', true);
  await closeWithReplacement('during', false);

  const root = makeRoot('guardian-helper-replacement-after');
  const socketPath = path.join(root, 'guardian.sock');
  const transport = createTrackedIpcServer({ platform: 'linux', socketPath, log: () => {} });
  await transport.listen({ onRequest: () => {} });
  await transport.close();
  fs.writeFileSync(socketPath, 'replacement-after');
  assert.equal(fs.readFileSync(socketPath, 'utf8'), 'replacement-after');
});

test('helper crash, ordered shutdown, and parent disconnect leave a stale path recoverable only with a dead marker', async () => {
  for (const mode of ['crash', 'shutdown', 'disconnect']) {
    const root = makeRoot(`guardian-helper-${mode}`);
    const socketPath = path.join(root, 'guardian.sock');
    const child = await startHelper(socketPath);
    const exited = waitForExit(child);
    if (mode === 'crash') child.kill('SIGKILL');
    else if (mode === 'shutdown') child.send({ type: 'shutdown' });
    else child.disconnect();
    await exited;
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);

    recoverStaleGuardianTransportArtifacts({
      platform: 'linux',
      socketPath,
      priorMarker: staleMarker(root, `helper-${mode}`, socketPath),
      liveness: () => 'dead',
    });
    assert.equal(fs.existsSync(socketPath), false);
  }
});

test('parent disconnect before helper ready leaves no public or owner artifacts for 20 cycles', async () => {
  const root = makeRoot('guardian-helper-disconnect-before-ready');
  for (let index = 0; index < 20; index += 1) {
    const socketPath = path.join(root, `guardian-${index}.sock`);
    await startHelperAndDisconnectBeforeReady(socketPath);
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(fs.existsSync(`${socketPath}.owner`), false);
    assert.equal(
      fs.readdirSync(root).some((entry) => entry.includes(`guardian-${index}.sock`)),
      false,
    );
  }
});

test('unannounced helper quarantine uncertainty retains parent authority for a retry', async () => {
  const root = makeRoot('guardian-helper-unannounced-cleanup-uncertain');
  const socketPath = path.join(root, 'guardian.sock');
  const helperPath = path.join(root, 'unannounced-cleanup-helper.mjs');
  const candidatePath = path.join(root, 'candidate-state');
  writeUnannouncedCleanupFailureHelper(helperPath, candidatePath);

  const transport = createTrackedIpcServer({
    platform: 'linux',
    socketPath,
    helperPath,
    log: () => {},
  });
  const listen = transport.listen({ onRequest: () => {} });
  for (let attempt = 0; attempt < 200 && !fs.existsSync(candidatePath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fs.readFileSync(candidatePath, 'utf8'), 'ready-candidate');

  const realUnlinkSync = fs.unlinkSync.bind(fs);
  let denyParentCleanup = true;
  fs.unlinkSync = (target, ...args) => {
    if (denyParentCleanup && typeof target === 'string' && target.endsWith('.remove')) {
      throw Object.assign(new Error('parent quarantine unlink denied'), { code: 'EACCES' });
    }
    return realUnlinkSync(target, ...args);
  };

  try {
    const close = transport.close();
    await assert.rejects(listen, { code: 'GUARDIAN_TRANSPORT_LISTEN_CANCELLED' });
    await assert.rejects(close, { code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN' });
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
    assert.equal(fs.lstatSync(`${socketPath}.owner`).isSocket(), true);
    assert.equal(
      fs.readdirSync(root).some((entry) => entry.endsWith('.remove')),
      true,
    );
  } finally {
    fs.unlinkSync = realUnlinkSync;
  }

  denyParentCleanup = false;
  await transport.close();
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(`${socketPath}.owner`), false);
  assert.equal(
    fs.readdirSync(root).some((entry) => entry.endsWith('.remove')),
    false,
  );
});

test('parent fails closed when ready identities do not include the descriptor identity', async () => {
  const root = makeRoot('guardian-helper-replacement-before-ready');
  const socketPath = path.join(root, 'guardian.sock');
  const helperPath = path.join(root, 'replacement-helper.mjs');
  writeReadyIdentityMismatchHelper(helperPath);
  const transport = createTrackedIpcServer({
    platform: 'linux',
    socketPath,
    helperPath,
    log: () => {},
  });

  await assert.rejects(transport.listen({ onRequest: () => {} }), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });
  assert.equal(fs.existsSync(socketPath), true);
  assert.equal(fs.existsSync(`${socketPath}.owner`), true);
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  await assert.rejects(transport.close(), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });
  acknowledgeExpectedTransportFailure(transport);
});

test('helper preserves a deterministic public replacement before ready identity capture', async () => {
  const root = makeRoot('guardian-helper-replacement-between-bind-alias');
  const socketPath = path.join(root, 'guardian.sock');
  const helperPath = path.join(root, 'replacement-helper.mjs');
  writeBindToAliasReplacementHelper(helperPath);
  const transport = createTrackedIpcServer({
    platform: 'linux',
    socketPath,
    helperPath,
    log: () => {},
  });

  await assert.rejects(transport.listen({ onRequest: () => {} }), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });
  assert.equal(fs.readFileSync(socketPath, 'utf8'), 'replacement-between-bind-and-alias');
  assert.equal(fs.lstatSync(`${socketPath}.owner`).isSocket(), true);
  await assert.rejects(transport.close(), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });
  acknowledgeExpectedTransportFailure(transport);
});

test('native owner replacement before first identity capture never reports ready', async () => {
  const root = makeRoot('guardian-helper-owner-replacement-before-identity');
  const socketPath = path.join(root, 'guardian.sock');
  const ownerPath = `${socketPath}.owner`;
  const helperPath = path.join(root, 'owner-replacement-helper.mjs');
  const replacementReadyPath = path.join(root, 'replacement-ready');
  const replacementCountPath = path.join(root, 'replacement-connections');
  const replacementPidPath = path.join(root, 'replacement-pid');
  trackReplacementProcess(replacementPidPath, ownerPath);
  writeOwnerPathReplacementHelper(
    helperPath,
    ownerPath,
    replacementReadyPath,
    replacementCountPath,
    replacementPidPath,
  );

  const transport = createTrackedIpcServer({
    platform: 'linux',
    socketPath,
    helperPath,
    log: () => {},
  });
  let parentConnections = 0;
  await assert.rejects(transport.listen({ onRequest: () => { parentConnections += 1; } }), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });

  assert.equal(parentConnections, 0);
  assert.equal(Number(fs.readFileSync(replacementCountPath, 'utf8')), 1);
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  assert.equal(fs.lstatSync(ownerPath).isSocket(), true);
  // The replacement server received the public probe, but the helper never
  // reported ready and the parent never accepted a forwarded handle.
  await assert.rejects(transport.close(), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });
  acknowledgeExpectedTransportFailure(transport);
});

test('replacement after parent pathname corroboration cannot pass helper readiness acceptance', async () => {
  const root = makeRoot('guardian-helper-replacement-after-parent-check');
  const socketPath = path.join(root, 'guardian.sock');
  const ownerPath = `${socketPath}.owner`;
  const readyPath = path.join(root, 'replacement-ready');
  const countPath = path.join(root, 'replacement-connections');
  let replaced = false;
  const transport = createTrackedIpcServer({ platform: 'linux', socketPath, log: () => {} });
  const originalLstatSync = fs.lstatSync;
  fs.lstatSync = function replaceAfterOwnerCheck(target, ...args) {
    const stat = originalLstatSync.call(this, target, ...args);
    if (target === ownerPath && !replaced && stat.isSocket?.() && fs.existsSync(socketPath)) {
      replaced = true;
      fs.unlinkSync(socketPath);
      fs.unlinkSync(ownerPath);
      startReplacementListenerSynchronously(
        socketPath,
        ownerPath,
        readyPath,
        countPath,
      );
    }
    return stat;
  };

  try {
    await assert.rejects(transport.listen({ onRequest: () => {} }), {
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
    });
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.equal(replaced, true);
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  assert.equal(fs.lstatSync(ownerPath).isSocket(), true);

  const client = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('replacement listener dial timeout')), 2_000);
    client.once('connect', () => {
      clearTimeout(timer);
      setTimeout(() => {
        client.destroy();
        resolve();
      }, 50);
    });
    client.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(countPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(Number(fs.readFileSync(countPath, 'utf8')) >= 1, true);
  await assert.rejects(transport.close(), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });
  acknowledgeExpectedTransportFailure(transport);
});

test('replacement after the helper final proof but before ready delivery never resolves healthy', async () => {
  const root = makeRoot('guardian-helper-replacement-after-final-proof');
  const socketPath = path.join(root, 'guardian.sock');
  const ownerPath = `${socketPath}.owner`;
  const helperPath = path.join(root, 'ready-delivery-replacement-helper.mjs');
  const replacementReadyPath = path.join(root, 'replacement-ready');
  const replacementCountPath = path.join(root, 'replacement-connections');
  writeReadyDeliveryReplacementHelper(
    helperPath,
    socketPath,
    ownerPath,
    replacementReadyPath,
    replacementCountPath,
  );

  const transport = createTrackedIpcServer({
    platform: 'linux',
    socketPath,
    helperPath,
    log: () => {},
  });
  let parentConnections = 0;
  await assert.rejects(transport.listen({
    onRequest: () => { parentConnections += 1; },
  }), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });

  assert.equal(parentConnections, 0);
  assert.equal(fs.readFileSync(replacementReadyPath, 'utf8'), 'ready');
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  assert.equal(fs.lstatSync(ownerPath).isSocket(), true);

  // Startup never adopted the replacement identity; close therefore remains
  // fail-closed and leaves both replacement pathnames for explicit recovery.
  await assert.rejects(transport.close(), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });
  acknowledgeExpectedTransportFailure(transport);
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  assert.equal(fs.lstatSync(ownerPath).isSocket(), true);
});

test('replacement after helper final proof and before commit delivery is retained', async () => {
  const root = makeRoot('guardian-helper-replacement-before-commit');
  const socketPath = path.join(root, 'guardian.sock');
  const ownerPath = `${socketPath}.owner`;
  const helperPath = path.join(root, 'commit-delivery-replacement-helper.mjs');
  const replacementReadyPath = path.join(root, 'replacement-ready');
  const replacementCountPath = path.join(root, 'replacement-connections');
  const replacementPidPath = path.join(root, 'replacement-pid');
  trackReplacementProcess(replacementPidPath, ownerPath);
  writeCommitDeliveryReplacementHelper(
    helperPath,
    socketPath,
    ownerPath,
    replacementReadyPath,
    replacementCountPath,
    replacementPidPath,
  );

  const transport = createTrackedIpcServer({
    platform: 'linux',
    socketPath,
    helperPath,
    log: () => {},
  });
  let parentConnections = 0;
  await assert.rejects(transport.listen({
    onRequest: () => { parentConnections += 1; },
  }), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });

  assert.equal(parentConnections, 0);
  assert.equal(fs.readFileSync(replacementReadyPath, 'utf8'), 'ready');
  const replacementPublicIdentity = snapshotFileIdentity(fs.lstatSync(socketPath));
  const replacementOwnerIdentity = snapshotFileIdentity(fs.lstatSync(ownerPath));
  assert.ok(replacementPublicIdentity);
  assert.ok(replacementOwnerIdentity);
  assert.deepEqual(replacementPublicIdentity, replacementOwnerIdentity);

  // The parent rejected the commit after its post-commit identity fence. The
  // replacement remains the live pair and is not adopted or unlinked by
  // startup rollback or the subsequent fail-closed close retry.
  await assert.rejects(transport.close(), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });
  acknowledgeExpectedTransportFailure(transport);
  assert.deepEqual(snapshotFileIdentity(fs.lstatSync(socketPath)), replacementPublicIdentity);
  assert.deepEqual(snapshotFileIdentity(fs.lstatSync(ownerPath)), replacementOwnerIdentity);
});

test('does not adopt a replacement pair reported during helper shutdown', async () => {
  const root = makeRoot('guardian-helper-replacement-during-shutdown');
  const socketPath = path.join(root, 'guardian.sock');
  const ownerPath = `${socketPath}.owner`;
  const transport = createTrackedIpcServer({ platform: 'linux', socketPath, log: () => {} });
  await transport.listen({ onRequest: () => {} });

  // Remove both published names while the original helper still owns its
  // listener FD, then publish a different listener pair at the same names.
  // The helper must not hand those replacement identities back as cleanup
  // authority when its shutdown frame arrives.
  fs.unlinkSync(socketPath);
  fs.unlinkSync(ownerPath);
   const replacement = trackServer(net.createServer());
  await new Promise((resolve, reject) => {
    replacement.once('error', reject);
    replacement.listen(ownerPath, () => {
      try {
        fs.linkSync(ownerPath, socketPath);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });

  await assert.rejects(transport.close(), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });
  acknowledgeExpectedTransportFailure(transport);
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  assert.equal(fs.lstatSync(ownerPath).isSocket(), true);
});

test('repeated helper transport lifecycles return descriptors and child processes to baseline', async () => {
  const root = makeRoot('guardian-helper-baseline');
  const descriptorCount = () => fs.readdirSync('/proc/self/fd').length;
  const childCount = () => {
    const body = fs.readFileSync(`/proc/self/task/${process.pid}/children`, 'utf8').trim();
    return body ? body.split(/\s+/).length : 0;
  };
  const beforeDescriptors = descriptorCount();
  const beforeChildren = childCount();

  for (let index = 0; index < 12; index += 1) {
    const socketPath = path.join(root, `guardian-${index}.sock`);
    const transport = createTrackedIpcServer({ platform: 'linux', socketPath, log: () => {} });
    await transport.listen({ onRequest: () => {} });
    await transport.close();
    assert.equal(fs.existsSync(socketPath), false);
  }

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(descriptorCount() <= beforeDescriptors + 1);
  assert.ok(childCount() <= beforeChildren);
});

test('shutdown timeout kills the dedicated helper before identity cleanup', async () => {
  const root = makeRoot('guardian-helper-shutdown-timeout');
  const socketPath = path.join(root, 'guardian.sock');
  const helperPath = path.join(root, 'stubborn-helper.mjs');
  const identityModule = new URL('./file-identity.js', import.meta.url).href;
  fs.writeFileSync(helperPath, `
    import fs from 'node:fs';
    import net from 'node:net';
    import { snapshotFileIdentity } from ${JSON.stringify(identityModule)};
     let server;
     let probeClient;
      let tokenSocket;
      let publicationToken;
      let publicationProof;
      let commitSent = false;
     process.on('message', (message) => {
       if (message?.type === 'publication-handle-ready') {
         probeClient?.write('guardian-ipc-publication-handle:' + publicationToken + '\\n');
         return;
       }
       if (message?.type === 'accept-ready') {
         process.send({
           type: 'ready',
           publicationToken,
           publicationProof,
           identity: publicationProof.publicIdentity,
           handleIdentity: publicationProof,
           publicIdentity: publicationProof.publicIdentity,
           ownerIdentity: publicationProof.ownerIdentity,
         });
          return;
        }
       if (message?.type !== 'listen') return;
        server = net.createServer((socket) => {
          socket.once('data', () => {
            tokenSocket = socket;
            socket.pause();
            process.send({
              type: 'ready-candidate',
              publicationHandle: 'accepted-probe',
              publicationToken,
              publicationProof,
              identity: publicationProof.publicIdentity,
              handleIdentity: publicationProof,
              publicIdentity: publicationProof.publicIdentity,
              ownerIdentity: publicationProof.ownerIdentity,
            }, tokenSocket);
          });
        });
        const ownerPath = \`\${message.socketPath}.owner\`;
        server.listen(ownerPath, () => {
          fs.chmodSync(ownerPath, 0o600);
          fs.linkSync(ownerPath, message.socketPath);
             const publicIdentity = snapshotFileIdentity(fs.lstatSync(message.socketPath));
             const ownerIdentity = snapshotFileIdentity(fs.lstatSync(ownerPath));
             const listenerIdentity = snapshotFileIdentity(fs.fstatSync(server._handle.fd));
             const pathDescriptor = fs.openSync(ownerPath, 0x200000 | (fs.constants.O_NOFOLLOW ?? 0));
            const descriptorIdentity = snapshotFileIdentity(fs.fstatSync(pathDescriptor));
            fs.closeSync(pathDescriptor);
              publicationToken = 'c'.repeat(64);
              publicationProof = {
               token: publicationToken,
               listenerIdentity,
               boundPathIdentity: ownerIdentity,
              descriptorIdentity,
               publicIdentity,
               ownerIdentity,
             };
            probeClient = net.createConnection(message.socketPath, () => {
              probeClient.write('stubborn-probe\\n');
            });
             probeClient.on('data', (chunk) => {
               const data = chunk.toString();
               if (!commitSent && data.includes('guardian-ipc-publication-accept:' + publicationToken)) {
                 commitSent = true;
                 probeClient.write('guardian-ipc-publication-commit:' + publicationToken + '\\n');
                 return;
               }
               if (commitSent && data.includes('guardian-ipc-publication-commit-ack:' + publicationToken)) {
                 probeClient.write('guardian-ipc-publication-commit-confirm:' + publicationToken + '\\n');
               }
             });
       });
      // Deliberately ignore shutdown: the parent must use its child handle.
    });
  `);

  const transport = createTrackedIpcServer({
    platform: 'linux',
    socketPath,
    helperPath,
    helperShutdownTimeoutMs: 25,
    log: () => {},
  });
  await transport.listen({ onRequest: () => {} });
  await transport.close();
  assert.equal(fs.existsSync(socketPath), false);
});

test('tracked child exit waits are bounded and report cleanup failure', async () => {
  const child = trackChild(spawn(process.execPath, [
    '--input-type=module',
    '-e',
    'setInterval(() => {}, 1000);',
  ], { stdio: 'ignore' }));

  await assert.rejects(waitForExit(child, 25), (error) => {
    assert.equal(error?.code, 'BOUNDARY_CHILD_EXIT_TIMEOUT');
    assert.match(error?.message || '', /did not exit within 25ms/);
    return true;
  });
  assert.equal(child.exitCode, null);
  await terminateChild(child);
});

test('missing replacement tracker fails closed while the validated replacement remains alive', async () => {
  const root = makeRoot('guardian-helper-missing-replacement-tracker');
  const pidPath = path.join(root, 'replacement-pid');
  const expectedCommand = path.join(root, 'replacement-listener');
  const replacement = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `const expectedCommand = ${JSON.stringify(expectedCommand)}; void expectedCommand; setInterval(() => {}, 1000);`,
  ], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  assert.ok(replacement.pid);
  fs.writeFileSync(pidPath, String(replacement.pid));
  trackReplacementProcess(pidPath, expectedCommand);
  const entry = trackedReplacementProcesses.get(pidPath);
  captureReplacementProcessIdentity(pidPath, entry);
  const replacementIdentity = entry.identity;

  fs.unlinkSync(pidPath);
  await assert.rejects(cleanupTrackedResources(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some((cause) => cause?.code === 'BOUNDARY_REPLACEMENT_TRACKER_MISSING'));
    return true;
  });
  assert.equal(trackedReplacementProcesses.has(pidPath), true);
  assert.equal(probeProcessLiveness(replacement.pid), 'alive');
  assert.equal(compareProcessIdentity(replacementIdentity, readProcessIdentity(replacement.pid)), null);
  assert.equal(fs.existsSync(root), true);

  // The tracker is intentionally absent, so cleanup must not signal merely on
  // the cached PID. This process was created by this test and is terminated
  // through its own validated ChildProcess handle after the fail-closed check.
  assert.equal(replacement.kill('SIGTERM'), true);
  await waitForExit(replacement);
  await cleanupTrackedResources();
  assert.equal(trackedReplacementProcesses.has(pidPath), false);
  cleanupRoots();
});

test('missing helper and ambiguous identity fail closed without deleting an unknown path', async () => {
  const root = makeRoot('guardian-helper-failure');
  const socketPath = path.join(root, 'guardian.sock');
  const failed = createTrackedIpcServer({
    platform: 'linux',
    socketPath,
    helperPath: path.join(root, 'missing-helper.js'),
    log: () => {},
  });
  await assert.rejects(failed.listen({ onRequest: () => {} }), {
    code: 'GUARDIAN_TRANSPORT_HELPER_FAILED',
  });
  assert.equal(fs.existsSync(socketPath), false);
  await failed.close();

  const transport = createTrackedIpcServer({ platform: 'linux', socketPath, log: () => {} });
  const originalLstat = fs.lstatSync;
  let injected = false;
  fs.lstatSync = function ambiguousLstat(target, ...args) {
    if (target === socketPath && !injected && fs.existsSync(socketPath)) {
      injected = true;
      return { dev: 1, ino: 1, mode: 0o600, isSocket: () => false };
    }
    return originalLstat.call(this, target, ...args);
  };
  try {
    await assert.rejects(transport.listen({ onRequest: () => {} }), {
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
    });
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  // The first startup probe fails closed. Close must not capture a pair that
  // never passed the helper-ready fence; only persisted marker identity may
  // authorize later recovery.
  await assert.rejects(transport.close(), {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
  });
  acknowledgeExpectedTransportFailure(transport);
  assert.equal(fs.existsSync(socketPath), true);
  assert.equal(fs.existsSync(`${socketPath}.owner`), true);
});
