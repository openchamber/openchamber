import { createIpcDialer } from './ipc-transport.js';

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
  #connectTimeoutMs;
  #requestTimeoutMs;
  #socket = null;
  #pending = new Map();
  #buffer = '';
  #connectPromise = null;
  #disposed = false;
  #dial = null;

  constructor({
    socketPath,
    portPath,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    // Backward-compatible signature. Legacy callers (lifecycle.js and
    // existing tests) pass only `socketPath`; a missing/empty
    // `socketPath` is the canonical error condition preserved here for
    // every pre-W-A caller. The new `portPath` argument is optional
    // and only relevant on Windows (sub-phase W-B). On POSIX, the
    // existing `socketPath`-required contract is unchanged: an empty
    // `socketPath` always throws even when `portPath` is provided.
    if (typeof socketPath !== 'string' || socketPath.length === 0) {
      if (typeof portPath === 'string' && portPath.length > 0 && process.platform === 'win32') {
        // Windows opt-in: allow a Windows caller to pass only
        // `portPath`. POSIX callers must keep using `socketPath`.
      } else {
        throw new TypeError('Guardian client requires a socket path');
      }
    }
    this.#platform = process.platform;
    this.#socketPath = socketPath;
    this.#portPath = portPath;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    // The platform-specific dial function is constructed once and
    // reused. The transport factory is the only place that knows
    // about `net.createConnection` / discovery-file semantics; W-A
    // branches here only because the W-A plan keeps the consumer
    // surface stable — a future refactor can move the branching into
    // the factory itself.
    this.#dial = createIpcDialer({
      platform: this.#platform,
      socketPath: this.#socketPath,
      portPath: this.#portPath,
    });
  }

  connect() {
    if (this.#disposed) {
      throw new GuardianClientError('Guardian client is disposed', 'disposed');
    }
    if (this.#connectPromise) {
      return this.#connectPromise;
    }
    if (this.#socket && !this.#socket.destroyed) {
      return Promise.resolve();
    }

    this.#connectPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new GuardianClientError('Connection timeout', 'connect_timeout'));
      }, this.#connectTimeoutMs);

      const onConnect = () => {
        cleanup();
        resolve();
      };

      const onError = (error) => {
        cleanup();
        reject(new GuardianClientError(error.message, 'connect_error'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.#socket?.off('connect', onConnect);
        this.#socket?.off('error', onError);
      };

      let rawSocket;
      try {
        rawSocket = this.#dial();
      } catch (error) {
        clearTimeout(timeout);
        this.#connectPromise = null;
        // Sync construction errors (e.g. missing portPath on Windows,
        // discovery-file ENOENT) become connect-time GuardianClientErrors.
        reject(new GuardianClientError(error?.message ?? String(error), 'connect_error'));
        return;
      }

      this.#socket = rawSocket;
      this.#socket.on('connect', onConnect);
      this.#socket.on('error', onError);
      this.#socket.on('data', (chunk) => this.#onData(chunk));
      this.#socket.on('close', () => {
        this.#rejectAllPending(new GuardianClientError('Connection closed', 'connection_closed'));
      });
    });

    return this.#connectPromise;
  }

  #onData(chunk) {
    this.#buffer += chunk.toString();
    let lineEnd;
    while ((lineEnd = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, lineEnd).trim();
      this.#buffer = this.#buffer.slice(lineEnd + 1);
      if (!line) continue;
      this.#handleResponse(line);
    }
  }

  #handleResponse(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    if (!response || typeof response !== 'object' || !('id' in response)) {
      return;
    }
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

  async #call(method, params = {}) {
    await this.connect();
    if (this.#disposed) {
      throw new GuardianClientError('Guardian client is disposed', 'disposed');
    }
    if (this.#socket.destroyed) {
      this.#connectPromise = null;
      await this.connect();
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const request = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new GuardianClientError('Request timeout', 'request_timeout'));
      }, this.#requestTimeoutMs);

      this.#pending.set(id, { resolve, reject, timeout });

      try {
        this.#socket.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timeout);
        reject(new GuardianClientError(error.message, 'write_error'));
      }
    });
  }

  async spawn(params) {
    return this.#call('spawn', params);
  }

  async stop(params) {
    return this.#call('stop', params);
  }

  async health(params) {
    return this.#call('health', params);
  }

  async prepareHandoff(params) {
    return this.#call('prepare-handoff', params);
  }

  async list() {
    return this.#call('list');
  }

  async shutdown() {
    return this.#call('shutdown');
  }

  disconnect() {
    this.#disposed = true;
    this.#rejectAllPending(new GuardianClientError('Client disconnected', 'disconnected'));
    if (this.#socket) {
      try {
        this.#socket.end();
        this.#socket.destroy();
      } catch {
        // Ignore.
      }
      this.#socket = null;
    }
    this.#connectPromise = null;
  }
}
