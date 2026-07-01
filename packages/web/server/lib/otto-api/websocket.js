import { WebSocketServer } from 'ws';
import { parseRequestPathname } from '../terminal/index.js';
import { sendMessageStreamWsFrame } from '../event-stream/protocol.js';

export const OTTO_EVENTS_WS_PATH = '/ws/otto/events';
export const OTTO_EVENTS_WS_HEARTBEAT_MS = 30_000;
export const OTTO_EVENTS_REPLAY_LIMIT = 100;

let hubBroadcastFn = null;

export function broadcast(eventType, data) {
  hubBroadcastFn?.(eventType, data);
}

function normalizePatterns(rawPatterns) {
  if (!Array.isArray(rawPatterns) || rawPatterns.length === 0) {
    return ['*'];
  }

  const result = [];
  for (const entry of rawPatterns) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      result.push(trimmed);
    }
  }

  return result.length > 0 ? result : ['*'];
}

function eventMatches(patterns, eventType) {
  if (patterns.includes('*')) {
    return true;
  }

  for (const pattern of patterns) {
    if (pattern === eventType) {
      return true;
    }

    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, Math.max(pattern.length - 1, 0));
      if (prefix.length === 0) {
        return true;
      }

      if (eventType.startsWith(prefix)) {
        return true;
      }
    }
  }

  return false;
}

function sendJson(socket, payload) {
  return sendMessageStreamWsFrame(socket, payload);
}

export function createOttoEventsWebSocketRuntime({
  server,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  heartbeatIntervalMs = OTTO_EVENTS_WS_HEARTBEAT_MS,
  replayLimit = OTTO_EVENTS_REPLAY_LIMIT,
}) {
  const wsServer = new WebSocketServer({
    noServer: true,
  });

  /** @type {Array<{ eventId: string; eventType: string; data: unknown; timestamp: number }>} */
  const replay = [];

  /** @type {Map<import('ws').WebSocket, { patterns: string[] }>} */
  const clientState = new Map();

  /** @type {WeakMap<object, ReturnType<typeof setInterval>>} */
  const clientTimers = new WeakMap();

  let nextSeq = 1;

  const appendReplay = (entry) => {
    replay.push(entry);
    if (replay.length > replayLimit) {
      replay.splice(0, replay.length - replayLimit);
    }
  };

  const replayAfter = (lastEventId) => {
    if (!lastEventId) {
      return [];
    }

    const index = replay.findIndex((entry) => entry.eventId === lastEventId);
    return index === -1 ? [] : replay.slice(index + 1);
  };

  function detachClient(socket) {
    const timer = clientTimers.get(socket);
    if (timer != null) {
      clearInterval(timer);
      clientTimers.delete(socket);
    }

    clientState.delete(socket);
  }

  const fanOut = (entry) => {
    for (const [socket, state] of Array.from(clientState)) {
      if (socket.readyState !== 1) {
        continue;
      }

      if (!eventMatches(state.patterns, entry.eventType)) {
        continue;
      }

      if (!sendJson(socket, { type: 'event', ...entry })) {
        detachClient(socket);
      }
    }
  };

  const publish = (eventType, data) => {
    if (typeof eventType !== 'string' || eventType.length === 0) {
      return;
    }

    const eventId = (nextSeq++).toString();
    const timestamp = Date.now();
    const entry = { eventId, eventType, data, timestamp };

    appendReplay(entry);
    fanOut(entry);
  };

  hubBroadcastFn = publish;

  const acceptSocket = (socket, { requestedLastEventId = '' } = {}) => {
    clientState.set(socket, {
      patterns: normalizePatterns(null),
    });

    clientTimers.set(
      socket,
      setInterval(() => {
        if (socket.readyState !== 1) {
          return;
        }

        sendJson(socket, { type: 'heartbeat', timestamp: Date.now() });
      }, heartbeatIntervalMs),
    );

    const lastBufferedId = replay.length > 0 ? replay[replay.length - 1].eventId : null;

    sendJson(socket, {
      type: 'ready',
      serverTime: Date.now(),
      lastReplayEventId: lastBufferedId,
    });

    const pending = replayAfter(requestedLastEventId);
    for (const entry of pending) {
      const state = clientState.get(socket);
      if (!state || !eventMatches(state.patterns, entry.eventType)) {
        continue;
      }

      if (!sendJson(socket, { type: 'event', ...entry })) {
        detachClient(socket);
        break;
      }
    }

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        return;
      }

      const raw = data.toString();
      let parsed = null;

      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      if (!parsed || typeof parsed !== 'object') {
        return;
      }

      if (parsed.type === 'subscribe') {
        clientState.set(socket, {
          patterns: normalizePatterns(parsed.patterns),
        });

        sendJson(socket, {
          type: 'subscribed',
          patterns: clientState.get(socket)?.patterns ?? ['*'],
          serverTime: Date.now(),
        });
        return;
      }

      if (parsed.type === 'ping') {
        sendJson(socket, { type: 'pong', serverTime: Date.now() });
      }
    });

    socket.on('close', () => detachClient(socket));
    socket.on('error', () => detachClient(socket));

    sendJson(socket, {
      type: 'subscribed',
      patterns: clientState.get(socket)?.patterns ?? ['*'],
      serverTime: Date.now(),
    });
  };

  wsServer.on('connection', (socket, req) => {
    const rawUrl = typeof req?.url === 'string' ? req.url : OTTO_EVENTS_WS_PATH;
    const requestUrl = new URL(rawUrl, 'http://127.0.0.1');
    const requestedLastEventId = requestUrl.searchParams.get('lastEventId')?.trim() ?? '';
    acceptSocket(socket, {
      requestedLastEventId,
    });
  });

  const upgradeHandler = (req, socket, head) => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== OTTO_EVENTS_WS_PATH) {
      return;
    }

    const handleUpgrade = async () => {
      try {
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
    async close() {
      hubBroadcastFn = null;

      server.off('upgrade', upgradeHandler);

      for (const socket of wsServer.clients) {
        detachClient(socket);

        try {
          socket.close(1001, 'OpenChamber server shutdown');
        } catch {
        }
      }

      try {
        await new Promise((resolve) => {
          wsServer.close(() => resolve());
        });
      } catch {
      }
    },
  };
}
