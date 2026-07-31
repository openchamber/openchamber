import { randomBytes } from 'node:crypto';

import { createIpcDialer } from './ipc-transport.js';
import { readGuardianAuthSecret } from './auth-secret.js';
import { resolveGuardianPaths } from './paths.js';
import {
  createClientNonce,
  createHandshakeProof,
  createRequestMac,
  createSessionKey,
} from './ipc-auth.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

export class GuardianClientError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = 'GuardianClientError';
  }
}

export class GuardianClient {
  #platform;
  #socketPath;
  #portPath;
  #authSecretPath;
  #username;
  #aclInspector;
  #reparseChecker;
  #authSecretInput;
  #authSecret = null;
  #sessionKey = null;
  #connectTimeoutMs;
  #requestTimeoutMs;
  #socket = null;
  #pending = new Map();
  #buffer = '';
  #connectPromise = null;
  #challengeResolver = null;
  #challengeRejecter = null;
  #disposed = false;
  #dial = null;
  #sequence = 0;
  #requestQueue = Promise.resolve();

  constructor({
    socketPath,
    portPath,
    authSecret,
    authSecretPath,
    username,
    aclInspector,
    reparseChecker,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (typeof socketPath !== 'string' || socketPath.length === 0) {
      if (!(typeof portPath === 'string' && portPath.length > 0 && process.platform === 'win32')) {
        throw new TypeError('Guardian client requires a socket path');
      }
    }
    this.#platform = process.platform;
    this.#socketPath = socketPath;
    this.#portPath = portPath;
    this.#authSecretInput = Buffer.isBuffer(authSecret) ? Buffer.from(authSecret) : null;
    this.#username = username;
    this.#aclInspector = aclInspector;
    this.#reparseChecker = reparseChecker;
    this.#authSecretPath = authSecretPath
      || resolveGuardianPaths({
        platform: this.#platform,
        socketPath: this.#socketPath,
        portPath: this.#portPath,
      }).authSecretPath;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#dial = createIpcDialer({
      platform: this.#platform,
      socketPath: this.#socketPath,
      portPath: this.#portPath,
      username: this.#username,
      aclInspector: this.#aclInspector,
      reparseChecker: this.#reparseChecker,
    });
  }

  connect() {
    if (this.#disposed) throw new GuardianClientError('Guardian client is disposed', 'disposed');
    if (this.#socket && !this.#socket.destroyed && this.#sessionKey) return;
    if (this.#connectPromise) return this.#connectPromise;

    this.#connectPromise = (async () => {
      this.#authSecret = this.#authSecretInput
        ? Buffer.from(this.#authSecretInput)
        : readGuardianAuthSecret(this.#authSecretPath, {
          platform: this.#platform,
          username: this.#username,
          aclInspector: this.#aclInspector,
          reparseChecker: this.#reparseChecker,
        });

      let socket;
      try {
        socket = await this.#dial();
      } catch (error) {
        throw new GuardianClientError(error?.message ?? String(error), 'connect_error');
      }
      this.#socket = socket;
      this.#buffer = '';
      const challenge = new Promise((resolve, reject) => {
        this.#challengeResolver = resolve;
        this.#challengeRejecter = reject;
      });

      const connectWait = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new GuardianClientError('Connection timeout', 'connect_timeout'));
        }, this.#connectTimeoutMs);
        const cleanup = () => {
          clearTimeout(timeout);
          socket.off('connect', onConnect);
          socket.off('error', onError);
        };
        const onConnect = () => {
          cleanup();
          resolve();
        };
        const onError = (error) => {
          cleanup();
          reject(new GuardianClientError(error.message, 'connect_error'));
        };
        socket.once('connect', onConnect);
        socket.once('error', onError);
        if (socket.readyState === 'open' || socket.connecting === false) {
          // A mocked/in-process dialer may return an already connected socket.
          queueMicrotask(onConnect);
        }
      });

      socket.on('data', (chunk) => {
        // A timed-out request can leave bytes in flight on the old socket
        // after a replacement connection has been established. Never let
        // that stale frame enter the replacement session's buffer.
        if (this.#socket !== socket) return;
        this.#onData(chunk);
      });
      socket.on('close', () => {
        // A timed-out request can close an old socket after the next call has
        // already established a replacement connection. Do not let that old
        // close event clear the replacement session or reject its pending
        // handshake/RPC.
        if (this.#socket !== socket) return;
        this.#rejectAllPending(new GuardianClientError('Connection closed', 'connection_closed'));
        this.#challengeRejecter?.(new GuardianClientError('Connection closed', 'connection_closed'));
        this.#challengeResolver = null;
        this.#challengeRejecter = null;
        this.#sessionKey?.fill(0);
        this.#sessionKey = null;
        this.#connectPromise = null;
      });
      socket.on('error', () => {});

      await connectWait;
      let challengeTimer;
      const challengeTimeout = new Promise((_, reject) => {
        challengeTimer = setTimeout(
          () => reject(new GuardianClientError('Authentication challenge timeout', 'authentication_timeout')),
          this.#connectTimeoutMs,
        );
      });
      let challengeValue;
      try {
        challengeValue = await Promise.race([challenge, challengeTimeout]);
      } finally {
        clearTimeout(challengeTimer);
      }
      const clientNonce = createClientNonce();
      const handshakeId = this.#newRequestId('handshake');
      const handshakeResult = await this.#sendRaw({
        id: handshakeId,
        method: 'handshake',
        params: {
          clientNonce,
          proof: createHandshakeProof({
            secret: this.#authSecret,
            challenge: challengeValue,
            clientNonce,
          }),
        },
      });
      if (!handshakeResult?.authenticated) {
        throw new GuardianClientError('Guardian IPC authentication failed', 'authentication_failed');
      }
      this.#sessionKey = createSessionKey({
        secret: this.#authSecret,
        challenge: challengeValue,
        clientNonce,
      });
      clientNonce && Buffer.from(clientNonce, 'base64url').fill(0);
      this.#sequence = 0;
      return handshakeResult;
    })();

    return this.#connectPromise.catch((error) => {
      this.#sessionKey?.fill(0);
      this.#sessionKey = null;
      this.#authSecret?.fill(0);
      this.#authSecret = null;
      try { this.#socket?.destroy(); } catch { /* ignore */ }
      this.#socket = null;
      this.#connectPromise = null;
      if (error instanceof GuardianClientError) throw error;
      throw new GuardianClientError(error?.message ?? String(error), 'connect_error');
    });
  }

  #newRequestId(prefix) {
    return `${prefix}-${Date.now()}-${randomBytes(8).toString('hex')}`;
  }

  #onData(chunk) {
    this.#buffer += chunk.toString();
    let lineEnd;
    while ((lineEnd = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, lineEnd).trim();
      this.#buffer = this.#buffer.slice(lineEnd + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      if (response?.type === 'challenge' && typeof response.challenge === 'string') {
        this.#challengeResolver?.(response.challenge);
        this.#challengeResolver = null;
        this.#challengeRejecter = null;
        continue;
      }
      this.#handleResponse(response);
    }
  }

  #handleResponse(response) {
    if (!response || typeof response !== 'object' || !('id' in response)) return;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timeout);
    if ('error' in response) {
      pending.reject(new GuardianClientError(
        response.error?.message || 'Unknown error',
        response.error?.code || 'unknown_error',
      ));
    } else {
      pending.resolve(response.result);
    }
  }

  #rejectAllPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #sendRaw(request, { onSent } = {}) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new GuardianClientError('Guardian connection is not available', 'not_connected'));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(request.id);
        reject(new GuardianClientError('Request timeout', 'request_timeout'));
        // Once a request times out its server-side consumption is ambiguous:
        // the authenticated sequence may already have been accepted. Drop
        // this connection so the next call gets a fresh handshake/sequence
        // rather than guessing whether the old request reached the server.
        if (this.#socket === socket) {
          try { socket.destroy(); } catch { /* ignore */ }
        }
      }, this.#requestTimeoutMs);
      this.#pending.set(request.id, { resolve, reject, timeout });
      try {
        socket.write(`${JSON.stringify(request)}\n`);
        onSent?.();
      } catch (error) {
        this.#pending.delete(request.id);
        clearTimeout(timeout);
        reject(new GuardianClientError(error.message, 'write_error'));
      }
    });
  }

  #call(method, params = {}) {
    const operation = this.#requestQueue.then(async () => {
      await this.connect();
      if (this.#disposed) throw new GuardianClientError('Guardian client is disposed', 'disposed');
      if (!this.#socket || this.#socket.destroyed || !this.#sessionKey) {
        this.#connectPromise = null;
        await this.connect();
      }
      const sequence = this.#sequence;
      const id = this.#newRequestId(method);
      const request = {
        id,
        method,
        params,
        auth: {
          sequence,
          mac: createRequestMac({ sessionKey: this.#sessionKey, sequence, id, method, params }),
        },
      };
      return await this.#sendRaw(request, {
        // The server consumes the sequence after MAC verification and before
        // dispatching the handler, so advance on successful write rather
        // than only when a result response is successful.
        onSent: () => { this.#sequence = sequence + 1; },
      });
    });
    this.#requestQueue = operation.catch(() => {});
    return operation;
  }

  async spawn(params) { return this.#call('spawn', params); }
  async stop(params) { return this.#call('stop', params); }
  async health(params) { return this.#call('health', params); }
  async prepareHandoff(params) { return this.#call('prepare-handoff', params); }
  async abortHandoff(params) { return this.#call('abort-handoff', params); }
  async reload() { return this.#call('reload'); }
  async list() { return this.#call('list'); }
  async shutdown() { return this.#call('shutdown'); }

  // Close only this process's IPC connection. The guardian and its managed
  // children are deliberately unaffected by a detach.
  detach() {
    this.disconnect();
  }

  disconnect() {
    this.#disposed = true;
    this.#rejectAllPending(new GuardianClientError('Client disconnected', 'disconnected'));
    this.#challengeRejecter?.(new GuardianClientError('Client disconnected', 'disconnected'));
    this.#challengeResolver = null;
    this.#challengeRejecter = null;
    this.#sessionKey?.fill(0);
    this.#sessionKey = null;
    this.#authSecret?.fill(0);
    this.#authSecret = null;
    this.#authSecretInput?.fill(0);
    this.#authSecretInput = null;
    if (this.#socket) {
      try { this.#socket.end(); this.#socket.destroy(); } catch { /* ignore */ }
      this.#socket = null;
    }
    this.#connectPromise = null;
    this.#requestQueue = Promise.resolve();
  }
}
