import fs from 'node:fs/promises';
import net from 'node:net';
import { MAX_FRAME_BYTES, parseEngineFrame } from './contract.js';

const HELLO_TIMEOUT_MS = 5000;
const MAX_SESSIONS = 64;
const CLOSE_GRACE_MS = 2000;

const probeSocket = (path) => new Promise((resolve) => {
  const socket = net.createConnection(path);
  socket.once('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.once('error', () => resolve(false));
});

/** Removes a socket file a dead service left; refuses anything that is not a dead socket. */
async function clearStaleSocket(path) {
  let stats;
  try {
    stats = await fs.lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isSocket()) throw new Error('engine socket path is occupied by something else');
  if (await probeSocket(path)) throw new Error('another protected MCP service is listening');
  await fs.unlink(path);
}

/**
 * The call-only listener. In stage 1 the engine account also reaches admin.sock
 * through the admins group. The first line decides everything here:
 * a status request gets the redacted status, a hello for an enabled connection
 * becomes an MCP session, and anything else gets an error code and the door.
 */
export function createEngineSocketServer({ path, group = null, subject = null, store, status, sessions, log = () => {} }) {
  const sockets = new Set();
  const inSession = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      inSession.delete(socket);
    });
    let buffer = Buffer.alloc(0);
    let decided = false;
    const timer = setTimeout(() => answerError('hello_timeout'), HELLO_TIMEOUT_MS);
    const answer = (value) => {
      clearTimeout(timer);
      decided = true;
      socket.off('data', onData);
      socket.end(`${JSON.stringify(value)}\n`);
      // A client that never reads its refusal must not hold the slot.
      setTimeout(() => socket.destroy(), 2000).unref();
    };
    const answerError = (code) => {
      if (!decided) answer({ type: 'error', code });
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(0x0a);
      if (end === -1) {
        if (buffer.length > MAX_FRAME_BYTES) answerError('malformed_frame');
        return;
      }
      const parsed = parseEngineFrame(buffer.subarray(0, end).toString('utf8'));
      const rest = buffer.subarray(end + 1);
      if (!parsed.ok) return answerError(parsed.code);
      if (parsed.frame.type === 'status') return subject === null ? answer(status()) : answerError('unsupported_request');
      if (subject !== null && !store.subjectAllows(subject, parsed.frame.connection)) return answerError('connection_not_allowed');
      const definition = store.get(parsed.frame.connection);
      if (!definition) return answerError('unknown_connection');
      if (!definition.enabled) return answerError('connection_disabled');
      if (sessions.countAll() >= MAX_SESSIONS) return answerError('too_many_sessions');
      clearTimeout(timer);
      decided = true;
      socket.off('data', onData);
      inSession.add(socket);
      socket.write(`${JSON.stringify({ type: 'ready', connection: definition.id, name: definition.name })}\n`);
      sessions.open(definition, socket, { initial: rest, subject });
      return undefined;
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
    socket.on('end', () => {
      if (!decided) answerError('malformed_frame');
    });
  });
  server.on('error', (error) => log('engine_socket_error', { code: error.code ?? 'unknown' }));

  return {
    async listen() {
      await clearStaleSocket(path);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
          server.off('error', reject);
          resolve();
        });
      });
      if (group !== null) await fs.chown(path, -1, group);
      await fs.chmod(path, subject === null ? 0o660 : 0o666);
    },
    /**
     * Stops accepting and drops every socket that is not in a session; the
     * session manager ends the rest. A peer that never closes its side goes
     * after a grace period, so shutdown cannot wait on a client.
     */
    close: () => new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, CLOSE_GRACE_MS);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      for (const socket of sockets) if (!inSession.has(socket)) socket.destroy();
    }),
  };
}
