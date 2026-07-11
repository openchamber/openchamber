// WebSocket bridge between the Express server and OpenCode in Daytona sandboxes.
//
// Manages bidirectional communication channels from the frontend (via this
// server) to the OpenCode instance running inside each sandbox. Handles
// connection establishment, message relay, and reconnection on failure.

import WebSocket from 'ws';

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * @param {{
 *   logger?: Pick<Console, 'log' | 'warn' | 'error'>,
 * }} dependencies
 */
export const createWsBridge = ({ logger = console } = {}) => {
  /** @type {Map<string, { ws: WebSocket | null, url: string, reconnectAttempts: number, reconnectTimer: ReturnType<typeof setTimeout> | null, messageQueue: Array<unknown> }>} */
  const connections = new Map();

  /**
   * Establish a WebSocket connection to the OpenCode instance in a sandbox.
   *
   * @param {string} sessionId - Chat session identifier.
   * @param {string} sandboxOpenCodeUrl - The WebSocket/HTTP URL to OpenCode in the sandbox.
   * @returns {Promise<void>}
   */
  const connect = async (sessionId, sandboxOpenCodeUrl) => {
    if (connections.has(sessionId)) {
      logger.warn(`[WsBridge] Connection already exists for session ${sessionId}`);
      return;
    }

    const wsUrl = sandboxOpenCodeUrl.replace(/^http/, 'ws');
    const state = {
      ws: null,
      url: wsUrl,
      reconnectAttempts: 0,
      reconnectTimer: null,
      messageQueue: [],
    };

    connections.set(sessionId, state);
    await establishConnection(sessionId, state);
  };

  /**
   * Internal: create the actual WebSocket connection with event handlers.
   *
   * @param {string} sessionId
   * @param {object} state
   */
  const establishConnection = (sessionId, state) => {
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(state.url);

        ws.on('open', () => {
          logger.log(`[WsBridge] Connected to sandbox OpenCode for session ${sessionId}`);
          state.ws = ws;
          state.reconnectAttempts = 0;

          // Flush queued messages
          while (state.messageQueue.length > 0) {
            const msg = state.messageQueue.shift();
            ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
          }

          resolve();
        });

        ws.on('close', () => {
          logger.warn(`[WsBridge] Connection closed for session ${sessionId}`);
          state.ws = null;
          attemptReconnect(sessionId, state);
        });

        ws.on('error', (error) => {
          logger.error(`[WsBridge] WebSocket error for session ${sessionId}: ${error?.message ?? error}`);
          state.ws = null;
          resolve(); // resolve even on error so we don't block
        });
      } catch (error) {
        logger.error(`[WsBridge] Failed to create WebSocket for session ${sessionId}: ${error?.message ?? error}`);
        resolve();
      }
    });
  };

  /**
   * Internal: attempt reconnection with exponential backoff.
   *
   * @param {string} sessionId
   * @param {object} state
   */
  const attemptReconnect = (sessionId, state) => {
    if (!connections.has(sessionId)) return; // disconnected intentionally
    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error(`[WsBridge] Max reconnect attempts reached for session ${sessionId}`);
      return;
    }

    state.reconnectAttempts += 1;
    const delay = RECONNECT_DELAY_MS * state.reconnectAttempts;

    logger.log(`[WsBridge] Reconnecting for session ${sessionId} in ${delay}ms (attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (connections.has(sessionId)) {
        establishConnection(sessionId, state);
      }
    }, delay);
  };

  /**
   * Disconnect the bridge for a session and clean up resources.
   *
   * @param {string} sessionId
   */
  const disconnect = (sessionId) => {
    const state = connections.get(sessionId);
    if (!state) return;

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    if (state.ws) {
      try {
        state.ws.close();
      } catch {
        // Ignore close errors
      }
      state.ws = null;
    }

    connections.delete(sessionId);
    logger.log(`[WsBridge] Disconnected bridge for session ${sessionId}`);
  };

  /**
   * Relay a message to the OpenCode instance in the sandbox.
   * If the connection is not ready, the message is queued.
   *
   * @param {string} sessionId
   * @param {unknown} message - The message to relay (string or object).
   */
  const relay = (sessionId, message) => {
    const state = connections.get(sessionId);
    if (!state) {
      logger.warn(`[WsBridge] No connection for session ${sessionId}, cannot relay message`);
      return;
    }

    const payload = typeof message === 'string' ? message : JSON.stringify(message);

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(payload);
    } else {
      state.messageQueue.push(payload);
    }
  };

  /**
   * Check whether a bridge connection is active for a session.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  const isConnected = (sessionId) => {
    const state = connections.get(sessionId);
    return state?.ws?.readyState === WebSocket.OPEN;
  };

  return {
    connect,
    disconnect,
    relay,
    isConnected,
  };
};
