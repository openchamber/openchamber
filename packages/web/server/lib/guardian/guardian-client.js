import net from 'node:net';

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
  #socketPath;
  #connectTimeoutMs;
  #requestTimeoutMs;
  #socket = null;
  #pending = new Map();
  #buffer = '';
  #connectPromise = null;
  #disposed = false;

  constructor({
    socketPath,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (typeof socketPath !== 'string' || socketPath.length === 0) {
      throw new TypeError('Guardian client requires a socket path');
    }
    this.#socketPath = socketPath;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#requestTimeoutMs = requestTimeoutMs;
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

      this.#socket = net.createConnection(this.#socketPath);
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
