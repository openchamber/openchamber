import fs from 'node:fs/promises';
import net from 'node:net';
import { isPlainObject, isString } from '../../shared/guards.js';
import { isConnectionId, ProtectedMcpError } from './contract.js';
import { parseOperation } from './store.js';
import { parseSubject, parseSubjectConnections } from './subject-contract.js';

const MAX_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 2000;
const ATTEMPT = /^[A-Za-z0-9_-]{22}$/;
const invalid = () => { throw new ProtectedMcpError('invalid_request'); };
const text = (value, max) => isString(value) && value.length <= max;

async function clearStaleSocket(path) {
  const stats = await fs.lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return;
  if (!stats.isSocket()) throw new Error('admin socket path is occupied');
  const listening = await new Promise((resolve) => {
    const probe = net.createConnection(path);
    probe.setTimeout(CLOSE_GRACE_MS, () => { probe.destroy(); resolve(true); });
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
  if (listening) throw new Error('another protected MCP administrator socket is listening');
  await fs.unlink(path);
}

/** Administrative authority comes only from the kernel's Unix socket permissions. */
export function createAdminSocketServer({ path, group = null, store, status, views, oauth, subjectListeners, log = () => {}, requestTimeoutMs = 5000 }) {
  const sockets = new Set();
  const requests = new Set();
  let closing = false;
  const view = async (id) => (await views()).find((connection) => connection.id === id) ?? null;
  const dispatch = async (frame) => {
    if (!isString(frame.type)) invalid();
    switch (frame.type) {
      case 'subjects':
        return { type: 'subjects', subjects: store.subjects() };
      case 'subject-set': {
        const subject = parseSubject(frame.subject);
        const connections = parseSubjectConnections(frame.connections);
        if (connections.some((id) => !store.get(id))) throw new ProtectedMcpError('unknown_connection', { status: 404 });
        return { type: 'subject', ...await subjectListeners.set(subject, connections) };
      }
      case 'subject-remove': {
        const subject = parseSubject(frame.subject);
        await subjectListeners.remove(subject);
        return { type: 'subject-removed', subject };
      }
      case 'list':
        return { type: 'connections', status: status(), connections: await views() };
      case 'get': {
        if (!isConnectionId(frame.id)) invalid();
        const connection = await view(frame.id);
        if (!connection) throw new ProtectedMcpError('connection_not_found', { status: 404 });
        return { type: 'connection', connection };
      }
      case 'apply': {
        const operation = parseOperation(frame.operation);
        const { connection: changed, removedCredentials } = await store.apply(operation);
        if (removedCredentials?.credentials?.oauth) {
          const { definition, credentials } = removedCredentials;
          const work = oauth.revokeUpstream(definition, credentials).catch(() => log('oauth_revocation_failed', { connection: definition.id }));
          requests.add(work);
          work.finally(() => requests.delete(work));
        }
        log('connection_changed', { kind: operation.kind, connection: changed?.id ?? operation.id });
        return { type: 'applied', connection: changed ? await view(changed.id) : null };
      }
      case 'oauth-start': {
        if (!isConnectionId(frame.id) || !Number.isSafeInteger(frame.expectedRevision) || !text(frame.redirectUri, 2048)) invalid();
        const { attempt, url } = await oauth.start({ id: frame.id, expectedRevision: frame.expectedRevision, redirectUri: frame.redirectUri });
        return { type: 'oauth-started', attempt, authorizationUrl: url };
      }
      case 'oauth-complete': {
        if (!text(frame.state, 4096) || (frame.code !== undefined && !text(frame.code, 4096)) || (frame.error !== undefined && !text(frame.error, 4096))) invalid();
        return { type: 'oauth-completed', ...await oauth.complete({ state: frame.state, code: frame.code, error: frame.error }) };
      }
      case 'oauth-attempt':
        if (!isString(frame.attempt) || !ATTEMPT.test(frame.attempt)) invalid();
        return { type: 'oauth-attempt', ...oauth.attempt(frame.attempt) };
      default:
        throw new ProtectedMcpError('unsupported_request');
    }
  };
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const full = sockets.size >= 16;
    sockets.add(socket);
    let decided = false;
    let buffer = Buffer.alloc(0);
    let destroyTimer;
    const timer = setTimeout(() => refuse(new ProtectedMcpError('request_timeout')), requestTimeoutMs);
    const answer = (frame) => {
      clearTimeout(timer);
      decided = true;
      socket.off('data', onData);
      if (!socket.destroyed && !socket.writableEnded) socket.end(`${JSON.stringify(frame)}\n`);
      destroyTimer = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
      destroyTimer.unref();
    };
    const refuse = (error) => {
      if (error instanceof ProtectedMcpError) answer({ type: 'error', code: error.code, status: error.status, message: error.message });
      else {
        log('admin_request_failed', { name: error?.name ?? 'Error' });
        answer({ type: 'error', code: 'internal_error', status: 500, message: 'internal_error' });
      }
    };
    const onData = (chunk) => {
      if (decided || closing) return;
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      if (buffer.length + part.length > MAX_BYTES) return refuse(new ProtectedMcpError('frame_too_large'));
      buffer = Buffer.concat([buffer, part]);
      if (newline === -1) return;
      decided = true;
      clearTimeout(timer);
      socket.off('data', onData);
      let frame;
      try {
        frame = JSON.parse(buffer.toString('utf8'));
        if (!isPlainObject(frame)) throw new Error('not an object');
      } catch {
        return refuse(new ProtectedMcpError('malformed_frame'));
      }
      buffer = Buffer.alloc(0);
      const work = dispatch(frame).then(answer, refuse);
      requests.add(work);
      work.finally(() => requests.delete(work));
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
    socket.once('end', () => { if (!decided) refuse(new ProtectedMcpError('malformed_frame')); });
    socket.once('close', () => {
      clearTimeout(timer);
      clearTimeout(destroyTimer);
      socket.off('data', onData);
      sockets.delete(socket);
    });
    if (full) refuse(new ProtectedMcpError('too_many_requests', { status: 503 }));
  });
  server.on('error', (error) => log('admin_socket_error', { code: error.code ?? 'unknown' }));
  return {
    async listen() {
      await clearStaleSocket(path);
      closing = false;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => { server.off('error', reject); resolve(); });
      });
      await fs.chmod(path, 0o660);
      if (group !== null) await fs.chown(path, -1, group);
    },
    async close() {
      closing = true;
      const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, CLOSE_GRACE_MS);
      await new Promise((resolve) => {
        server.close(resolve);
        for (const socket of sockets) socket.end();
      });
      clearTimeout(timer);
      // An accepted write can outlive a disconnected peer. Finish it before the store unlocks.
      while (requests.size > 0) await Promise.allSettled(requests);
    },
  };
}
