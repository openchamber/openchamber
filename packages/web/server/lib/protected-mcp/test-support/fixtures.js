import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProtectedMcpService } from '../service/service.js';
export const SENTINEL = 'sentinel-5d1e0b-never-leaves-the-service';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const repositoryScratch = fileURLToPath(new URL('../../../../../../.tmp/protected-mcp-tests/', import.meta.url));

/**
 * A directory the integrity check accepts: inside the repository's ignored
 * scratch folder, whose ancestors belong to root or the test user and are
 * writable by nobody else, unlike anything under the world-writable /tmp.
 */
export async function trustedFixtureDirectory() {
  await fs.mkdir(repositoryScratch, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(repositoryScratch, 'run-'));
  await fs.chmod(directory, 0o755);
  return { directory, remove: () => fs.rm(directory, { recursive: true, force: true }) };
}

/** Copies the stdio fixture server there as an executable and answers its path. */
export async function installStdioFixture(directory) {
  const target = path.join(directory, 'fixture-mcp-server.mjs');
  await fs.copyFile(fileURLToPath(new URL('./stdio-fixture-server.js', import.meta.url)), target);
  await fs.chmod(target, 0o755);
  return target;
}

/** A running service over temporary state, trusting files the test user owns. */
export async function startService({ enforcement, now, fetchImpl } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-mcp-'));
  const stateDir = path.join(root, 'state');
  const runDir = path.join(root, 'run');
  await fs.mkdir(runDir, { mode: 0o700 });
  const engineSocketPath = path.join(runDir, 'engine.sock');
  const adminSocketPath = path.join(runDir, 'admin.sock');
  const service = await createProtectedMcpService({
    version: 'test',
    stateDir,
    engineSocketPath,
    adminSocketPath,
    // Test files belong to the test user; a fake engine identity owns nothing.
    integrity: { owners: [0, process.getuid()], engine: { uid: 2_000_000_000, gids: [2_000_000_000] } },
    enforcement: enforcement ?? (async () => ({ status: 'unverified', checkedAt: 0, findings: [{ code: 'test_fixture', level: 'error' }] })),
    now,
    fetchImpl,
  });
  await service.start();
  const close = async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  };
  return { root, stateDir, engineSocketPath, adminSocketPath, service, close };
}

/** Sends one frame on the engine socket and collects every line until it closes. */
export function engineRequest(socketPath, frame, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('engine socket did not close'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${frame === undefined ? '' : JSON.stringify(frame)}\n`));
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(buffer.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    });
  });
}

/** Opens an MCP session on the engine socket: send, and read lines as they arrive. */
export function engineSession(socketPath, connection) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');
  const lines = [];
  const waiters = [];
  let buffer = '';
  let closed = false;
  const flush = () => {
    while (waiters.length > 0 && (lines.length > 0 || closed)) {
      const waiter = waiters.shift();
      if (lines.length > 0) waiter.resolve(lines.shift());
      else waiter.reject(new Error('session closed'));
    }
  };
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line) lines.push(JSON.parse(line));
    }
    flush();
  });
  socket.on('close', () => {
    closed = true;
    flush();
  });
  socket.on('error', () => {});
  socket.write(`${JSON.stringify({ type: 'hello', protocol: 1, connection })}\n`);
  return {
    send: (message) => socket.write(`${JSON.stringify(message)}\n`),
    next: ({ timeoutMs = 10_000 } = {}) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no message in time')), timeoutMs);
      waiters.push({
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      flush();
    }),
    /** Reads until a JSON-RPC response with `id` arrives, keeping other messages. */
    async response(id, options) {
      const others = [];
      for (;;) {
        const message = await this.next(options);
        if (message.id === id && (message.result !== undefined || message.error !== undefined)) return { message, others };
        others.push(message);
      }
    },
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      socket.once('close', resolve);
      socket.end();
    }),
    get closed() { return closed; },
  };
}
