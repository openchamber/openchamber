import { WebSocket } from 'ws';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

// Minimal Chrome DevTools Protocol client over the browser-level WebSocket
// endpoint using flat session mode. Commands and events for page targets are
// multiplexed on this single connection via `sessionId`.
export const connectCdp = (webSocketDebuggerUrl, { commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    const pending = new Map();
    const eventListeners = new Set();
    const closeListeners = new Set();
    let nextId = 1;
    let closed = false;

    const failAllPending = (message) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout);
        entry.reject(new Error(message));
      }
      pending.clear();
    };

    const connection = {
      send: (method, params = {}, sessionId = undefined) => {
        if (closed || socket.readyState !== WebSocket.OPEN) {
          return Promise.reject(new Error('Browser connection is closed'));
        }
        const id = nextId;
        nextId += 1;
        return new Promise((resolveCommand, rejectCommand) => {
          const timeout = setTimeout(() => {
            pending.delete(id);
            rejectCommand(new Error(`Browser command timed out: ${method}`));
          }, commandTimeoutMs);
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timeout, method });
          try {
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          } catch (error) {
            clearTimeout(timeout);
            pending.delete(id);
            rejectCommand(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
      onEvent: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onClose: (listener) => {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close: () => {
        if (closed) return;
        closed = true;
        failAllPending('Browser connection is closed');
        try {
          socket.close();
        } catch {
          // already closed
        }
      },
      get isOpen() {
        return !closed && socket.readyState === WebSocket.OPEN;
      },
    };

    socket.on('open', () => resolve(connection));
    socket.on('error', (error) => {
      if (!closed) reject(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on('close', () => {
      const wasClosed = closed;
      closed = true;
      failAllPending('Browser connection was closed');
      if (!wasClosed) {
        for (const listener of closeListeners) {
          try {
            listener();
          } catch {
            // listener errors must not break close handling
          }
        }
      }
    });
    socket.on('message', (raw) => {
      let message = null;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (Number.isInteger(message.id)) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timeout);
        if (message.error) {
          entry.reject(new Error(message.error.message || `Browser command failed: ${entry.method}`));
        } else {
          entry.resolve(message.result ?? {});
        }
        return;
      }
      if (typeof message.method === 'string') {
        for (const listener of eventListeners) {
          try {
            listener(message.method, message.params ?? {}, message.sessionId);
          } catch {
            // listener errors must not break the protocol pump
          }
        }
      }
    });
  });
};
