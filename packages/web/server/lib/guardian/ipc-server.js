import { EventEmitter } from 'node:events';

import { createIpcServer } from './ipc-transport.js';

/**
 * Guardian IPC server (transport-agnostic).
 *
 * Owns the JSON-line request/response protocol and method dispatch
 * (`spawn` / `stop` / `health` / `prepare-handoff` / `list` /
 * `shutdown`). Delegates the actual transport (Unix-domain socket on
 * POSIX; localhost-TCP in W-B) to `createIpcServer` from
 * `ipc-transport.js`. This file must not call `net.createServer`,
 * `chmodSync`, or `process.umask` — those are transport concerns.
 *
 * Trust boundary (Phase 2B):
 *   The transport is configured with `socketPath` (POSIX) or
 *   `portPath` (Windows) at construction time. POSIX enforces a
 *   `0600` mode + `0o077` umask on the Unix-domain socket; Windows
 *   (W-B) will enforce an icacls grant on the discovery file. Same-UID
 *   local processes are the documented trust boundary.
 */

const parseJsonLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const sendResponse = (socket, response) => {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(response)}\n`);
  }
};

const sendError = (socket, id, message, code = 'internal_error') => {
  sendResponse(socket, { id, error: { message, code } });
};

export class GuardianIpcServer extends EventEmitter {
  #platform;
  #socketPath;
  #portPath;
  #guardian;
  #log;
  #transport = null;
  #sockets = new Set();
  #methods = new Map();

  constructor({
    platform = process.platform,
    socketPath,
    portPath,
    guardian,
    log = () => {},
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
    this.#guardian = guardian;
    this.#log = log;
    this.#registerMethods();
  }

  #registerMethods() {
    this.#methods.set('spawn', async (params) => this.#guardian.spawnManagedOpenCode(params));
    this.#methods.set('stop', async (params) => this.#guardian.stopChild(params));
    this.#methods.set('health', async (params) => this.#guardian.healthCheck(params));
    this.#methods.set('prepare-handoff', async (params) => this.#guardian.prepareHandoff(params));
    this.#methods.set('list', async () => this.#guardian.listChildren());
    this.#methods.set('shutdown', async (params, ctx) => {
      // Send acknowledgement FIRST so the CLI can observe clean shutdown.
      // The implicit post-handler response would race with socket destruction
      // because guardian.stop() destroys all open sockets via ipcServer.stop().
      sendResponse(ctx.socket, { id: ctx.id, result: { acknowledged: true } });
      this.emit('shutdown');
      await this.#guardian.stop();
    });
  }

  async start() {
    if (this.#transport) {
      throw new Error('Guardian IPC server is already started');
    }

    this.#transport = createIpcServer({
      platform: this.#platform,
      socketPath: this.#socketPath,
      portPath: this.#portPath,
      log: this.#log,
    });

    await this.#transport.listen({
      onRequest: (socket) => {
        this.#sockets.add(socket);

        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          let lineEnd;
          while ((lineEnd = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);
            if (!line) continue;
            this.#handleRequest(socket, line);
          }
        });

        socket.on('close', () => {
          this.#sockets.delete(socket);
        });

        socket.on('error', (error) => {
          this.#log(`[guardian-ipc] socket error: ${error.message}`);
          this.#sockets.delete(socket);
        });
      },
    });
  }

  async #handleRequest(socket, line) {
    const request = parseJsonLine(line);
    if (!request || typeof request !== 'object') {
      sendError(socket, request?.id ?? null, 'Malformed JSON request', 'parse_error');
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

    const handler = this.#methods.get(method);
    if (!handler) {
      sendError(socket, id, `Method not found: ${method}`, 'method_not_found');
      return;
    }

    try {
      const result = await handler(params ?? {}, { socket, id });
      sendResponse(socket, { id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error?.code || 'execution_error';
      sendError(socket, id, message, code);
    }
  }

  async stop() {
    if (!this.#transport) {
      return;
    }

    for (const socket of this.#sockets) {
      try {
        socket.end();
        socket.destroy();
      } catch {
        // Ignore.
      }
    }
    this.#sockets.clear();

    const transport = this.#transport;
    this.#transport = null;
    await transport.close();
  }
}
