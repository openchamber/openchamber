import { WebSocketServer } from 'ws';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';

import { parseRequestPathname } from '../terminal/terminal-ws-protocol.js';
import {
  MESSAGE_STREAM_DIRECTORY_WS_PATH,
  MESSAGE_STREAM_GLOBAL_WS_PATH,
  MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  MESSAGE_STREAM_WS_MAX_PAYLOAD_BYTES,
  serializeMessageStreamWsEvent,
  sendMessageStreamWsFrame,
  sendSerializedMessageStreamWsFrame,
} from './protocol.js';
import { createGlobalMessageStreamHub, parseGlobalBlock } from './global-hub.js';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';
import { acceptDirectoryMessageStreamWsConnection } from './directory-ws-bridge.js';
import {
  createUpstreamSseReader,
  DEFAULT_UPSTREAM_RECONNECT_DELAY_MS,
  DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
} from './upstream-reader.js';

function messageStreamPayloadByteLength(data) {
  if (typeof data === 'string') {
    return Buffer.byteLength(data);
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data?.byteLength ?? Number.POSITIVE_INFINITY;
}

export function createGlobalUiEventBroadcaster({
  sseClients,
  wsClients,
  writeSseEvent,
}) {
  return (payload, options = {}) => {
    const hasSseClients = sseClients.size > 0;
    const hasWsClients = wsClients.size > 0;
    if (!hasSseClients && !hasWsClients) {
      return;
    }

    if (hasSseClients) {
      const serializedPayload = JSON.stringify(payload);
      for (const res of sseClients) {
        try {
          writeSseEvent(res, payload, serializedPayload);
        } catch {
        }
      }
    }

    if (hasWsClients) {
      const serializedFrame = serializeMessageStreamWsEvent(payload, {
        directory: typeof options.directory === 'string' && options.directory.length > 0 ? options.directory : 'global',
        eventId: typeof options.eventId === 'string' && options.eventId.length > 0 ? options.eventId : undefined,
      });
      for (const socket of Array.from(wsClients)) {
        const sent = sendSerializedMessageStreamWsFrame(socket, serializedFrame);
        if (!sent) {
          wsClients.delete(socket);
        }
      }
    }
  };
}

export function createMessageStreamWsRuntime({
  server,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  processForwardedEventPayload,
  wsClients,
  triggerHealthCheck,
  heartbeatIntervalMs = MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  upstreamStallTimeoutMs = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  upstreamReconnectDelayMs = DEFAULT_UPSTREAM_RECONNECT_DELAY_MS,
  fetchImpl = fetch,
  globalEventHub = null,
}) {
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MESSAGE_STREAM_WS_MAX_PAYLOAD_BYTES,
  });

  // Directory-scoped streams create one upstream reader per client
  // connection. Track those sockets so a managed OpenCode restart can close
  // them: each reader is pinned to the port it connected at and would
  // otherwise keep streaming from an orphaned process on the old port (#2638).
  const directorySockets = new Set();

  const ownsGlobalHub = !globalEventHub;
  const globalHub = globalEventHub ?? createGlobalMessageStreamHub({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl,
    upstreamStallTimeoutMs,
    upstreamReconnectDelayMs,
  });

  const globalBridge = createGlobalMessageStreamWsBridge({
    globalHub,
    ownsGlobalHub,
    wsClients,
    processForwardedEventPayload,
    triggerHealthCheck,
    heartbeatIntervalMs,
  });

  wsServer.on('connection', (socket, req) => {
    socket.on('message', (data) => {
      if (messageStreamPayloadByteLength(data) <= MESSAGE_STREAM_WS_MAX_PAYLOAD_BYTES) {
        return;
      }

      try {
        socket.close(1009, 'Message stream frame too large');
      } catch {
      }
    });

    const rawUrl = typeof req?.url === 'string' ? req.url : MESSAGE_STREAM_GLOBAL_WS_PATH;
    const pathname = parseRequestPathname(rawUrl);
    const requestUrl = new URL(rawUrl, 'http://127.0.0.1');
    const isGlobalStream = pathname === MESSAGE_STREAM_GLOBAL_WS_PATH;
    const requestedLastEventId = requestUrl.searchParams.get('lastEventId')?.trim() || '';
    const requestedDirectory = requestUrl.searchParams.get('directory')?.trim() || '';

    // A repeated scope parameter is ambiguous: never silently stream under
    // its first value (issue #2315). The sibling directory-scoped HTTP
    // surfaces reject the same input with a 400; this socket is already
    // upgraded, so refuse with an error frame and a policy close instead.
    if (requestUrl.searchParams.getAll('directory').length > 1 || requestUrl.searchParams.getAll('lastEventId').length > 1) {
      sendMessageStreamWsFrame(socket, {
        type: 'error',
        message: 'Ambiguous message stream parameters: directory and lastEventId may each appear at most once',
      });
      try {
        socket.close(1008, 'Ambiguous message stream parameters');
      } catch {
      }
      return;
    }

    if (isGlobalStream) {
      globalBridge.accept(socket, {
        requestedLastEventId,
      });
      return;
    }

    directorySockets.add(socket);
    socket.on('close', () => {
      directorySockets.delete(socket);
    });

    acceptDirectoryMessageStreamWsConnection({
      socket,
      requestedLastEventId,
      requestedDirectory,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      processForwardedEventPayload,
      wsClients,
      triggerHealthCheck,
      heartbeatIntervalMs,
      upstreamStallTimeoutMs,
      upstreamReconnectDelayMs,
      fetchImpl,
    });
  });

  const upgradeHandler = (req, socket, head) => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== MESSAGE_STREAM_GLOBAL_WS_PATH && pathname !== MESSAGE_STREAM_DIRECTORY_WS_PATH) {
      return;
    }

    const handleUpgrade = async () => {
      try {
        if (isOpaqueOriginRequest(req)) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        if (!uiAuthController?.enabled && !await isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed)) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController?.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
            return;
          }
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };

    void handleUpgrade();
  };

  server.on('upgrade', upgradeHandler);

  return {
    wsServer,
    /**
     * Rebind all upstream readers to the current OpenCode port. Called after
     * a managed process restart: the restart can land on a NEW port while
     * the old process (or an orphaned survivor of it) still holds the
     * previous one, and a healthy-but-pinned SSE connection never notices —
     * so the UI would stop receiving events until the app restarts (#2638).
     * Restarting the shared hub re-dials `buildOpenCodeUrl` (which reads the
     * current port) on its next attempt; directory-scoped readers are
     * rebuilt by closing their client sockets, which reconnect with
     * `Last-Event-ID` and re-establish the stream against the new port.
     */
    rebindUpstream({ closeDirectorySockets = true } = {}) {
      globalHub.stop();
      globalHub.start();
      if (!closeDirectorySockets) return;
      for (const socket of Array.from(directorySockets)) {
        try {
          socket.close(1012, 'OpenCode upstream restarted');
        } catch {
        }
      }
    },
    // Keeps reading a replaced OpenCode's events until the returned function is called, so the
    // sessions it still runs keep streaming to clients.
    followUpstream({ url, headers }) {
      const controller = new AbortController();
      const reader = createUpstreamSseReader({
        signal: controller.signal,
        fetchImpl,
        stallTimeoutMs: upstreamStallTimeoutMs,
        reconnectDelayMs: upstreamReconnectDelayMs,
        buildUrl: () => new URL('/api/event', url),
        getHeaders: () => headers,
        // Read the SSE `id:` line, so the followed OpenCode's ids reach the buffer and its reconnects.
        parseBlock: parseGlobalBlock,
        onEvent(event) {
          globalHub.injectEvent({
            payload: event.payload,
            directory: event.envelope?.directory,
            spaceId: event.envelope?.spaceId,
            eventId: event.eventId,
          });
        },
      });
      void reader.start();
      return () => {
        reader.stop();
        controller.abort();
      };
    },
    async close() {
      server.off('upgrade', upgradeHandler);
      globalBridge.close();

      try {
        for (const client of wsServer.clients) {
          try {
            client.terminate();
          } catch {
          }
        }

        await new Promise((resolve) => {
          wsServer.close(() => resolve());
        });
      } catch {
      } finally {
        wsClients.clear();
      }
    },
  };
}
