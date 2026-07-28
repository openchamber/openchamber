import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const DEFAULT_SOCKET_MODE = 0o600;

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
  #socketPath;
  #guardian;
  #log;
  #server = null;
  #sockets = new Set();
  #methods = new Map();

  constructor({ socketPath, guardian, log = () => {} }) {
    super();
    if (typeof socketPath !== 'string' || socketPath.length === 0) {
      throw new TypeError('Guardian IPC server requires a socket path');
    }
    if (!guardian || typeof guardian.spawnManagedOpenCode !== 'function') {
      throw new TypeError('Guardian IPC server requires a guardian');
    }
    this.#socketPath = socketPath;
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
    this.#methods.set('shutdown', async () => {
      const result = await this.#guardian.stop();
      this.emit('shutdown');
      return result;
    });
  }

  async start() {
    if (this.#server) {
      throw new Error('Guardian IPC server is already started');
    }

    return new Promise((resolve, reject) => {
      this.#server = net.createServer((socket) => {
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
      });

      this.#server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`Guardian IPC socket already in use: ${this.#socketPath}`));
          return;
        }
        reject(error);
      });

      const previousUmask = process.umask(0o077);
      this.#server.listen(this.#socketPath, () => {
        process.umask(previousUmask);
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.#socketPath, DEFAULT_SOCKET_MODE);
          } catch (chmodError) {
            this.#log(`[guardian-ipc] failed to chmod socket: ${chmodError.message}`);
          }
        }
        this.#log(`[guardian-ipc] listening on ${this.#socketPath}`);
        resolve();
      });
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
      const result = await handler(params ?? {});
      sendResponse(socket, { id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error?.code || 'execution_error';
      sendError(socket, id, message, code);
    }
  }

  async stop() {
    if (!this.#server) {
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

    return new Promise((resolve) => {
      this.#server.close(() => {
        this.#server = null;
        resolve();
      });

      if (process.platform !== 'win32') {
        try {
          fs.unlinkSync(this.#socketPath);
        } catch {
          // Ignore.
        }
      }
    });
  }
}
