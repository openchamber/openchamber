import { randomBytes } from 'node:crypto';

import { createIpcDialer } from './ipc-transport.js';
import { readGuardianAuthSecret } from './auth-secret.js';
import { resolveGuardianPaths } from './paths.js';
import {
  createClientNonce,
  createHandshakeProof,
  createRequestMac,
  createSessionKey,
  GUARDIAN_IPC_MAX_FRAME_BYTES,
} from './ipc-auth.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const GUARDIAN_AMBIGUOUS_REQUEST_CODE = 'GUARDIAN_REQUEST_AMBIGUOUS';
const NON_IDEMPOTENT_METHODS = new Set([
  'spawn',
  'stop',
  'prepare-handoff',
  'abort-handoff',
  'reload',
  'shutdown',
]);
const isNonIdempotentMethod = (method) => NON_IDEMPOTENT_METHODS.has(method);
const createGuardianOperationId = () => randomBytes(32).toString('base64url');
const hasCompleteOwnerIdentity = (owner) => owner !== null
  && typeof owner === 'object'
  && !Array.isArray(owner)
  && typeof owner.ownerInstanceId === 'string'
  && owner.ownerInstanceId.length > 0
  && typeof owner.runtimeIdentity === 'string'
  && owner.runtimeIdentity.length > 0
  && typeof owner.launchFingerprint === 'string'
  && owner.launchFingerprint.length > 0;
const hasOwnerScopeIdentity = (owner) => owner !== null
  && typeof owner === 'object'
  && !Array.isArray(owner)
  && typeof owner.ownerInstanceId === 'string'
  && owner.ownerInstanceId.length > 0
  && typeof owner.runtimeIdentity === 'string'
  && owner.runtimeIdentity.length > 0;

export class GuardianClientError extends Error {
  constructor(message, code, { ambiguous = false } = {}) {
    super(message);
    this.code = ambiguous ? GUARDIAN_AMBIGUOUS_REQUEST_CODE : code;
    if (ambiguous) {
      // The code is intentionally stable because lifecycle error sanitization
      // preserves public error codes but not arbitrary properties. It is also
      // the explicit non-retryable contract for side-effecting RPC callers.
      this.ambiguous = true;
      this.retryable = false;
      this.originalCode = code;
    }
    this.name = 'GuardianClientError';
  }
}

export const isAmbiguousGuardianRequestError = (error) => (
  error?.ambiguous === true
  || error?.code === GUARDIAN_AMBIGUOUS_REQUEST_CODE
  || error?.originalCode === GUARDIAN_AMBIGUOUS_REQUEST_CODE
);

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
        this.#rejectAllPending(new GuardianClientError('Connection closed', 'connection_closed'), {
          markSentRequestsAmbiguous: true,
        });
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
      const rawLine = this.#buffer.slice(0, lineEnd);
      this.#buffer = this.#buffer.slice(lineEnd + 1);
      // The newline is part of the wire frame. Check each frame separately so
      // two valid responses coalesced into one TCP chunk are not rejected just
      // because their combined chunk exceeds the per-frame limit.
      if (Buffer.byteLength(`${rawLine}\n`, 'utf8') > GUARDIAN_IPC_MAX_FRAME_BYTES) {
        const error = new GuardianClientError('Guardian IPC frame is too large', 'frame_too_large');
        this.#rejectAllPending(error, { markSentRequestsAmbiguous: true });
        try { this.#socket?.destroy(); } catch { /* ignore */ }
        this.#buffer = '';
        return;
      }
      const line = rawLine.trim();
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
    // A partial frame must still leave room for its terminating newline. An
    // exact-limit unterminated buffer can therefore never become a valid
    // frame and is rejected before it grows further.
    if (Buffer.byteLength(this.#buffer, 'utf8') >= GUARDIAN_IPC_MAX_FRAME_BYTES) {
      const error = new GuardianClientError('Guardian IPC frame is too large', 'frame_too_large');
      this.#rejectAllPending(error, { markSentRequestsAmbiguous: true });
      try { this.#socket?.destroy(); } catch { /* ignore */ }
      this.#buffer = '';
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

  #rejectAllPending(error, { markSentRequestsAmbiguous = false } = {}) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        markSentRequestsAmbiguous && pending.sent && isNonIdempotentMethod(pending.method)
          ? new GuardianClientError(
            'Connection closed before the Guardian request result was known',
            error.code,
            { ambiguous: true },
          )
          : error,
      );
    }
    this.#pending.clear();
  }

  #sendRaw(request, { onSent } = {}) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new GuardianClientError('Guardian connection is not available', 'not_connected'));
    }
    let frame;
    try {
      frame = `${JSON.stringify(request)}\n`;
    } catch (error) {
      return Promise.reject(new GuardianClientError(error?.message || String(error), 'write_error'));
    }
    if (Buffer.byteLength(frame, 'utf8') > GUARDIAN_IPC_MAX_FRAME_BYTES) {
      return Promise.reject(new GuardianClientError('Guardian IPC frame is too large', 'frame_too_large'));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(request.id);
        reject(new GuardianClientError('Request timeout; request outcome is unknown', 'request_timeout', {
          ambiguous: isNonIdempotentMethod(request.method),
        }));
        // Once a request times out its server-side consumption is ambiguous:
        // the authenticated sequence may already have been accepted. Drop
        // this connection so the next call gets a fresh handshake/sequence
        // rather than guessing whether the old request reached the server.
        if (this.#socket === socket) {
          try { socket.destroy(); } catch { /* ignore */ }
        }
      }, this.#requestTimeoutMs);
      const pending = {
        resolve,
        reject,
        timeout,
        method: request.method,
        sent: false,
      };
      this.#pending.set(request.id, pending);
      try {
        // Mark the request before handing it to the socket so a synchronous
        // close/error cannot incorrectly report a sent side effect as known.
        pending.sent = true;
        socket.write(frame);
        onSent?.();
      } catch (error) {
        pending.sent = false;
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
      try {
        return await this.#sendRaw(request, {
        // The server consumes the sequence after MAC verification and before
        // dispatching the handler, so advance on successful write rather
        // than only when a result response is successful. There is deliberately
        // no automatic retry here: an ambiguous non-idempotent request may
        // already have performed its side effect.
        onSent: () => { this.#sequence = sequence + 1; },
        });
      } catch (error) {
        if (isNonIdempotentMethod(method) && typeof params?.operationId === 'string') {
          error.operationId = params.operationId;
        }
        throw error;
      }
    });
    this.#requestQueue = operation.catch(() => {});
    return operation;
  }

  async spawn(params = {}) {
    const operationId = params.operationId || createGuardianOperationId();
    return this.#call('spawn', { ...params, operationId });
  }
  async stop(params = {}) {
    const operationId = params.operationId || createGuardianOperationId();
    return this.#call('stop', { ...params, operationId });
  }
  async health(params = {}) {
    if (typeof params?.incarnation !== 'string' || params.incarnation.length === 0
      || !hasCompleteOwnerIdentity(params.owner)) {
      throw new GuardianClientError(
        'Guardian health requires the exact owner and incarnation identity',
        'owner_required',
      );
    }
    return this.#call('health', params);
  }
  async credential(params = {}) {
    if (typeof params?.incarnation !== 'string' || params.incarnation.length === 0
      || !hasCompleteOwnerIdentity(params.owner)) {
      throw new GuardianClientError(
        'Guardian credential requires the exact owner and incarnation identity',
        'owner_required',
      );
    }
    return this.#call('credential', params);
  }
  async confirmAdoption(params = {}) {
    if (typeof params?.incarnation !== 'string' || params.incarnation.length === 0
      || !hasCompleteOwnerIdentity(params.owner)
      || !Number.isSafeInteger(params.expected?.revision)
      || !Number.isSafeInteger(params.expected?.leaseExpiresAt)
      || typeof params.expected?.mac !== 'string'
      || params.expected.mac.length === 0) {
      throw new GuardianClientError(
        'Guardian adoption confirmation requires the exact owner, incarnation, and record binding',
        'owner_required',
      );
    }
    return this.#call('confirm-adoption', params);
  }
  async terminalStatus(params = {}) {
    if (typeof params?.incarnation !== 'string' || params.incarnation.length === 0
      || !hasCompleteOwnerIdentity(params.owner)) {
      throw new GuardianClientError(
        'Guardian terminal status requires the exact owner and incarnation identity',
        'owner_required',
      );
    }
    return this.#call('terminal-status', params);
  }
  async confirmTerminal(params = {}) {
    if (typeof params?.incarnation !== 'string' || params.incarnation.length === 0
      || !hasCompleteOwnerIdentity(params.owner)
      || !Number.isSafeInteger(params.expected?.revision)
      || !Number.isSafeInteger(params.expected?.leaseExpiresAt)
      || typeof params.expected?.mac !== 'string'
      || params.expected.mac.length === 0) {
      throw new GuardianClientError(
        'Guardian terminal confirmation requires the exact owner, incarnation, and record binding',
        'owner_required',
      );
    }
    return this.#call('confirm-terminal', params);
  }
  async prepareHandoff(params = {}) {
    const operationId = params.operationId || createGuardianOperationId();
    return this.#call('prepare-handoff', { ...params, operationId });
  }
  async abortHandoff(params = {}) {
    const operationId = params.operationId || createGuardianOperationId();
    return this.#call('abort-handoff', { ...params, operationId });
  }
  async operationStatus(params = {}) {
    if (typeof params.operationId !== 'string' || params.operationId.length === 0
      || !hasCompleteOwnerIdentity(params.owner)) {
      throw new GuardianClientError(
        'Guardian operation status requires the exact operation and owner identity',
        'owner_required',
      );
    }
    return this.#call('operation-status', params);
  }
  async operationList(params = {}) {
    if (!hasOwnerScopeIdentity(params.owner)) {
      throw new GuardianClientError(
        'Guardian operation discovery requires the exact owner identity',
        'owner_required',
      );
    }
    return this.#call('operation-list', params);
  }
  async admissionStatus() {
    return this.#call('admission-status');
  }
  async resolveOperation(params = {}) {
    if (typeof params.operationId !== 'string' || params.operationId.length === 0
      || !hasCompleteOwnerIdentity(params.owner)) {
      throw new GuardianClientError(
        'Guardian operation resolution requires the exact operation and owner identity',
        'owner_required',
      );
    }
    return this.#call('resolve-operation', params);
  }
  async confirmOperation(params = {}) {
    if (typeof params.operationId !== 'string' || params.operationId.length === 0
      || !hasCompleteOwnerIdentity(params.owner)) {
      throw new GuardianClientError(
        'Guardian operation confirmation requires the exact operation and owner identity',
        'owner_required',
      );
    }
    return this.#call('confirm-operation', params);
  }
  async expireOperation(params = {}) {
    if (typeof params.operationId !== 'string' || params.operationId.length === 0
      || !hasCompleteOwnerIdentity(params.owner)) {
      throw new GuardianClientError(
        'Guardian operation expiry requires the exact operation and owner identity',
        'owner_required',
      );
    }
    return this.#call('expire-operation', params);
  }
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
    this.#rejectAllPending(new GuardianClientError('Client disconnected', 'disconnected'), {
      markSentRequestsAmbiguous: true,
    });
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
