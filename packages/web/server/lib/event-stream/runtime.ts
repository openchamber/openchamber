import { WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket } from '../shared/websocket-contracts.js';
import type { RequestOriginChecker, createRequestSecurityRuntime } from '../security/request-security.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import type { BridgeOptions, EventRouting, StreamSocket, UpstreamConnection } from './contracts.js';
import type { GlobalMessageStreamHub } from './global-hub.js';
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
import { isString } from '../shared/object-guards.js';

function messageStreamPayloadByteLength(data: string | Buffer | ArrayBuffer | Buffer[] | null | undefined) {
  if (isString(data)) {
    return Buffer.byteLength(data);
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data?.byteLength ?? Number.POSITIVE_INFINITY;
}
export interface GlobalUiEventBroadcasterOptions<SseClient> {
  sseClients: Set<SseClient>;
  wsClients: Set<StreamSocket>;
  writeSseEvent: <Payload>(res: SseClient, payload: Payload, serializedPayload: string | undefined) => void;
}

export interface MessageStreamWsRuntimeOptions extends UpstreamConnection, Omit<BridgeOptions, 'heartbeatIntervalMs'> {
  server: Pick<Server, 'on' | 'off'>;
  uiAuthController?: Partial<Pick<ReturnType<typeof createUiAuth>, 'enabled' | 'ensureSessionToken'>> | null;
  isRequestOriginAllowed: RequestOriginChecker;
  rejectWebSocketUpgrade: ReturnType<typeof createRequestSecurityRuntime>['rejectWebSocketUpgrade'];
  heartbeatIntervalMs?: number;
  globalEventHub?: GlobalMessageStreamHub | null;
}

const isRequestUrl = (value: unknown): value is string => typeof value === 'string';

export function createGlobalUiEventBroadcaster<SseClient>({
  sseClients,
  wsClients,
  writeSseEvent,
}: GlobalUiEventBroadcasterOptions<SseClient>) {
  return <Payload>(payload: Payload, options: EventRouting = {}) => {
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
          void 0;
        }
      }
    }

    if (hasWsClients) {
      const serializedFrame = serializeMessageStreamWsEvent(payload, {
        directory: options.directory && options.directory.length > 0 ? options.directory : 'global',
        eventId: options.eventId && options.eventId.length > 0 ? options.eventId : undefined,
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
}: MessageStreamWsRuntimeOptions) {
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MESSAGE_STREAM_WS_MAX_PAYLOAD_BYTES,
  });

  const directorySockets = new Set<WebSocket>();

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
        // Best effort: nothing more to do when this fails.
      }
    });

    const rawUrl = isRequestUrl(req?.url) ? req.url : MESSAGE_STREAM_GLOBAL_WS_PATH;
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
        // Best effort: nothing more to do when this fails.
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
      isHiddenPayload: globalHub.isHiddenPayload,
    });
  });

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
    rebindUpstream({ closeDirectorySockets = true } = {}) {
      globalHub.stop();
      globalHub.start();
      if (!closeDirectorySockets) return;
      for (const socket of Array.from(directorySockets)) {
        try {
          socket.close(1012, 'OpenCode upstream restarted');
        } catch {
          void 0;
        }
      }
    },
    // Keeps reading a replaced OpenCode's events until the returned function is called, so the
    // sessions it still runs keep streaming to clients.
    followUpstream({ url, headers }: { url: string | URL; headers: Record<string, string> }) {
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
          const injected: Parameters<typeof globalHub.injectEvent>[0] = {
            payload: event.payload,
            directory: event.envelope?.directory ?? '',
            spaceId: event.envelope?.spaceId ?? null,
          };
          if (event.eventId) injected.eventId = event.eventId;
          globalHub.injectEvent(injected);
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
        const clients = wsServer.clients;
        if (!clients) throw new TypeError('WebSocket client tracking is unavailable');
        for (const client of clients) {
          try {
            client.terminate();
          } catch {
            void 0;
          }
        }

        await new Promise<void>((resolve) => {
          wsServer.close(() => resolve());
        });
      } catch {
        void 0;
      } finally {
        wsClients.clear();
      }
    },
  };
}
