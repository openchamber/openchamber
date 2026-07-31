import { EventEmitter } from 'node:events';
import path from 'node:path';

import { createIpcServer } from './ipc-transport.js';
import { ensureGuardianAuthSecret } from './auth-secret.js';
import { resolveGuardianPaths } from './paths.js';
import {
  createChallenge,
  createHandshakeProof,
  createSessionKey,
  createRequestMac,
  decodeNonce,
  verifyEncodedMac,
} from './ipc-auth.js';

const parseJsonLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const sendResponse = (socket, response) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
};

const sendError = (socket, id, message, code = 'internal_error') => {
  sendResponse(socket, { id, error: { message, code } });
};

/**
 * Authenticated JSON-line guardian IPC server.
 *
 * A connection receives a one-shot challenge, proves possession of the
 * per-installation secret, then authenticates every ordered request with a
 * session-key MAC and monotonically increasing sequence number. No reusable
 * bearer is sent in a request and unauthenticated methods never reach the
 * guardian dispatcher.
 */
export class GuardianIpcServer extends EventEmitter {
  static RESPONSE_SENT = Symbol('guardian-ipc-response-sent');

  #platform;
  #socketPath;
  #portPath;
  #guardian;
  #log;
  #transport = null;
  #sockets = new Set();
  #connections = new Map();
  #methods = new Map();
  #authSecretPath;
  #aclInspector;
  #reparseChecker;
  #authSecretInput;
  #authSecret = null;

  constructor({
    platform = process.platform,
    socketPath,
    portPath,
    guardian,
    log = () => {},
    authSecret,
    authSecretPath,
    aclInspector,
    reparseChecker,
  } = {}) {
    super();
    if (!guardian || typeof guardian.spawnManagedOpenCode !== 'function') {
      throw new TypeError('Guardian IPC server requires a guardian');
    }
    if (
      (typeof socketPath !== 'string' || socketPath.length === 0)
      && (typeof portPath !== 'string' || portPath.length === 0)
    ) {
      throw new TypeError('Guardian IPC server requires a socketPath or portPath');
    }
    this.#platform = platform;
    this.#socketPath = socketPath;
    this.#portPath = portPath;
    if (this.#platform === 'win32' && (typeof this.#portPath !== 'string' || this.#portPath.length === 0)) {
      throw new TypeError('Windows portPath is required');
    }
    if (this.#platform !== 'win32' && (typeof this.#socketPath !== 'string' || this.#socketPath.length === 0)) {
      throw new TypeError('POSIX socketPath is required');
    }
    this.#guardian = guardian;
    this.#log = log;
    this.#authSecretInput = Buffer.isBuffer(authSecret) ? Buffer.from(authSecret) : null;
    this.#aclInspector = aclInspector;
    this.#reparseChecker = reparseChecker;
    this.#authSecretPath = authSecretPath
      || resolveGuardianPaths({
        platform: this.#platform,
        socketPath: this.#socketPath,
        portPath: this.#portPath,
      }).authSecretPath;
    this.#registerMethods();
  }

  #registerMethods() {
    this.#methods.set('spawn', async (params) => this.#guardian.spawnManagedOpenCode(params));
    this.#methods.set('stop', async (params) => this.#guardian.stopChild({
      incarnation: params?.incarnation,
      owner: params?.owner,
    }));
    this.#methods.set('health', async (params) => this.#guardian.healthCheck(params));
    this.#methods.set('prepare-handoff', async (params) => this.#guardian.prepareHandoff({
      incarnation: params?.incarnation,
      owner: params?.owner,
    }));
    this.#methods.set('abort-handoff', async (params) => this.#guardian.abortHandoff({
      incarnation: params?.incarnation,
      owner: params?.owner,
    }));
    this.#methods.set('reload', async () => this.#guardian.reload());
    this.#methods.set('list', async () => this.#guardian.listChildren());
    this.#methods.set('shutdown', async (params, ctx) => {
      // The guardian closes accepted sockets while stopping. Acknowledging
      // before that close is part of the protocol contract.
      sendResponse(ctx.socket, { id: ctx.id, result: { acknowledged: true } });
      this.emit('shutdown');
      await this.#guardian.stop();
      return GuardianIpcServer.RESPONSE_SENT;
    });
  }

  async start() {
    if (this.#transport) throw new Error('Guardian IPC server is already started');

    this.#authSecret = this.#authSecretInput
      ? Buffer.from(this.#authSecretInput)
      : await ensureGuardianAuthSecret({
        rootDir: path.dirname(this.#authSecretPath),
        platform: this.#platform,
        username: this.#guardian.username,
        log: this.#log,
        aclInspector: this.#aclInspector,
        reparseChecker: this.#reparseChecker,
      });

    try {
      this.#transport = createIpcServer({
        platform: this.#platform,
        socketPath: this.#socketPath,
        portPath: this.#portPath,
        username: this.#guardian.username,
        aclInspector: this.#aclInspector,
        reparseChecker: this.#reparseChecker,
        log: this.#log,
      });
      await this.#transport.listen({
        onRequest: (socket) => {
          this.#sockets.add(socket);
          const connection = {
            challenge: createChallenge(),
            sessionKey: null,
            nextSequence: 0,
            authenticated: false,
          };
          this.#connections.set(socket, connection);
          sendResponse(socket, { type: 'challenge', challenge: connection.challenge });

          let buffer = '';
          socket.on('data', (chunk) => {
            buffer += chunk.toString();
            let lineEnd;
            while ((lineEnd = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, lineEnd).trim();
              buffer = buffer.slice(lineEnd + 1);
              if (line) void this.#handleRequest(socket, line, connection);
            }
          });

          socket.on('close', () => {
            this.#sockets.delete(socket);
            connection.sessionKey?.fill(0);
            this.#connections.delete(socket);
          });

          socket.on('error', (error) => {
            this.#log(`[guardian-ipc] socket error: ${error.message}`);
            this.#sockets.delete(socket);
            connection.sessionKey?.fill(0);
            this.#connections.delete(socket);
          });
        },
      });
    } catch (error) {
      this.#transport = null;
      this.#authSecret?.fill(0);
      this.#authSecret = null;
      throw error;
    }
  }

  async #handleRequest(socket, line, connection) {
    const request = parseJsonLine(line);
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      sendError(socket, null, 'Malformed JSON request', 'parse_error');
      return;
    }

    const { id, method, params } = request;
    if (typeof id !== 'string' && typeof id !== 'number') {
      sendError(socket, null, 'Request id is required', 'invalid_request');
      return;
    }
    if (typeof method !== 'string') {
      sendError(socket, id, 'Method is required', 'invalid_request');
      return;
    }

    if (!connection?.authenticated) {
      if (method !== 'handshake' || !params || typeof params !== 'object' || Array.isArray(params)) {
        sendError(socket, id, 'Guardian IPC authentication is required', 'authentication_required');
        return;
      }
      const clientNonce = decodeNonce(params.clientNonce);
      const expectedProof = clientNonce
        ? createHandshakeProof({
          secret: this.#authSecret,
          challenge: connection.challenge,
          clientNonce: params.clientNonce,
        })
        : null;
      const valid = Boolean(
        clientNonce
        && expectedProof
        && verifyEncodedMac(params.proof, Buffer.from(expectedProof, 'base64url')),
      );
      clientNonce?.fill(0);
      if (!valid) {
        sendError(socket, id, 'Guardian IPC authentication failed', 'authentication_failed');
        return;
      }
      connection.sessionKey = createSessionKey({
        secret: this.#authSecret,
        challenge: connection.challenge,
        clientNonce: params.clientNonce,
      });
      connection.authenticated = true;
      sendResponse(socket, { id, result: { authenticated: true, protocol: 'v1' } });
      return;
    }

    if (method === 'handshake') {
      sendError(socket, id, 'Guardian IPC connection is already authenticated', 'authentication_replay');
      return;
    }

    const sequence = request.auth?.sequence;
    if (!Number.isSafeInteger(sequence) || sequence !== connection.nextSequence) {
      sendError(socket, id, 'Guardian IPC request replay detected', 'replay_detected');
      return;
    }
    const expectedMac = createRequestMac({
      sessionKey: connection.sessionKey,
      sequence,
      id,
      method,
      params: params ?? {},
    });
    if (!verifyEncodedMac(request.auth?.mac, Buffer.from(expectedMac, 'base64url'))) {
      sendError(socket, id, 'Guardian IPC request authentication failed', 'authentication_failed');
      return;
    }
    connection.nextSequence += 1;

    const handler = this.#methods.get(method);
    if (!handler) {
      sendError(socket, id, `Method not found: ${method}`, 'method_not_found');
      return;
    }

    try {
      const result = await handler(params ?? {}, { socket, id });
      if (result !== GuardianIpcServer.RESPONSE_SENT) {
        sendResponse(socket, { id, result });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error?.code || 'execution_error';
      sendError(socket, id, message, code);
    }
  }

  async stop() {
    if (!this.#transport) return;

    for (const socket of this.#sockets) {
      try {
        socket.end();
        socket.destroy();
      } catch {
        // Ignore.
      }
    }
    this.#sockets.clear();
    for (const connection of this.#connections.values()) connection.sessionKey?.fill(0);
    this.#connections.clear();

    const transport = this.#transport;
    this.#transport = null;
    try {
      await transport.close();
    } finally {
      this.#authSecret?.fill(0);
      this.#authSecret = null;
      this.#authSecretInput?.fill(0);
      this.#authSecretInput = null;
    }
  }
}
