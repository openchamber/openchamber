import { WebSocketServer } from 'ws';

import { parseRequestPathname } from '../terminal/index.js';
import {
  MESSAGE_STREAM_DIRECTORY_WS_PATH,
  MESSAGE_STREAM_GLOBAL_WS_PATH,
  MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  parseSseEventEnvelope,
  sendMessageStreamWsEvent,
  sendMessageStreamWsFrame,
} from './protocol.js';

const MESSAGE_STREAM_UPSTREAM_STALL_TIMEOUT_MS = 20_000;
const MESSAGE_STREAM_UPSTREAM_RECONNECT_DELAY_MS = 250;

function shouldTriggerUpstreamHealthCheck(upstream) {
  if (!upstream) {
    return true;
  }

  if (!upstream.body) {
    return upstream.ok || upstream.status >= 500;
  }

  return upstream.status >= 500;
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
      for (const res of sseClients) {
        try {
          writeSseEvent(res, payload);
        } catch {
        }
      }
    }

    if (hasWsClients) {
      for (const socket of Array.from(wsClients)) {
        const sent = sendMessageStreamWsEvent(socket, payload, {
          directory: typeof options.directory === 'string' && options.directory.length > 0 ? options.directory : 'global',
          eventId: typeof options.eventId === 'string' && options.eventId.length > 0 ? options.eventId : undefined,
        });
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
  upstreamStallTimeoutMs = MESSAGE_STREAM_UPSTREAM_STALL_TIMEOUT_MS,
  upstreamReconnectDelayMs = MESSAGE_STREAM_UPSTREAM_RECONNECT_DELAY_MS,
  fetchImpl = fetch,
}) {
  const wsServer = new WebSocketServer({
    noServer: true,
  });

  wsServer.on('connection', (socket, req) => {
    const rawUrl = typeof req?.url === 'string' ? req.url : MESSAGE_STREAM_GLOBAL_WS_PATH;
    const pathname = parseRequestPathname(rawUrl);
    const requestUrl = new URL(rawUrl, 'http://127.0.0.1');
    const isGlobalStream = pathname === MESSAGE_STREAM_GLOBAL_WS_PATH;
    const requestedLastEventId = requestUrl.searchParams.get('lastEventId')?.trim() || '';
    const requestedDirectory = requestUrl.searchParams.get('directory')?.trim() || '';

    const controller = new AbortController();
    let currentUpstreamAbortController = null;
    let upstreamConnected = false;
    let streamReady = false;
    let lastEventId = requestedLastEventId;
    const cleanup = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
      if (currentUpstreamAbortController && !currentUpstreamAbortController.signal.aborted) {
        currentUpstreamAbortController.abort();
      }
      wsClients.delete(socket);
    };

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const pingInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      try {
        socket.ping();
      } catch {
      }
    }, heartbeatIntervalMs);

    const heartbeatInterval = setInterval(() => {
      if (!upstreamConnected) {
        return;
      }

      sendMessageStreamWsEvent(socket, { type: 'openchamber:heartbeat', timestamp: Date.now() }, { directory: 'global' });
    }, heartbeatIntervalMs);

    socket.on('close', () => {
      clearInterval(pingInterval);
      clearInterval(heartbeatInterval);
      upstreamConnected = false;
      cleanup();
    });

    socket.on('error', () => {
      void 0;
    });

    const run = async () => {
      const forwardBlock = (block) => {
        if (!block) {
          return;
        }

        const envelope = parseSseEventEnvelope(block);
        const payload = envelope?.payload ?? null;
        if (!payload) {
          return;
        }

        const directory = isGlobalStream
          ? (typeof envelope?.directory === 'string' && envelope.directory.length > 0 ? envelope.directory : 'global')
          : (requestedDirectory || envelope?.directory || 'global');

        if (typeof envelope?.eventId === 'string' && envelope.eventId.length > 0) {
          lastEventId = envelope.eventId;
        }

        sendMessageStreamWsEvent(socket, payload, {
          directory,
          eventId: typeof envelope?.eventId === 'string' && envelope.eventId.length > 0 ? envelope.eventId : undefined,
        });

        processForwardedEventPayload(payload, (syntheticPayload) => {
          sendMessageStreamWsEvent(socket, syntheticPayload, { directory: 'global' });
        });
      };

      try {
        while (!controller.signal.aborted) {
          let targetUrl;
          try {
            targetUrl = new URL(buildOpenCodeUrl(isGlobalStream ? '/global/event' : '/event', ''));
          } catch {
            sendMessageStreamWsFrame(socket, { type: 'error', message: 'OpenCode service unavailable' });
            socket.close(1011, 'OpenCode service unavailable');
            return;
          }

          if (!isGlobalStream && requestedDirectory) {
            targetUrl.searchParams.set('directory', requestedDirectory);
          }

          const headers = {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...getOpenCodeAuthHeaders(),
          };
          if (lastEventId) {
            headers['Last-Event-ID'] = lastEventId;
          }

          const upstreamController = new AbortController();
          currentUpstreamAbortController = upstreamController;
          const abortUpstream = () => upstreamController.abort();
          controller.signal.addEventListener('abort', abortUpstream, { once: true });

          let upstream;
          try {
            upstream = await fetchImpl(targetUrl.toString(), {
              headers,
              signal: upstreamController.signal,
            });
          } catch {
            controller.signal.removeEventListener('abort', abortUpstream);
            currentUpstreamAbortController = null;
            upstreamConnected = false;
            if (controller.signal.aborted) {
              return;
            }
            if (!streamReady) {
              sendMessageStreamWsFrame(socket, { type: 'error', message: 'Failed to connect to OpenCode event stream' });
              socket.close(1011, 'Failed to connect to OpenCode event stream');
              triggerHealthCheck?.();
              return;
            }
            await wait(upstreamReconnectDelayMs);
            continue;
          }

          if (!upstream.ok || !upstream.body) {
            controller.signal.removeEventListener('abort', abortUpstream);
            currentUpstreamAbortController = null;
            upstreamConnected = false;
            if (!streamReady) {
              sendMessageStreamWsFrame(socket, {
                type: 'error',
                message: `OpenCode event stream unavailable (${upstream.status})`,
              });
              socket.close(1011, 'OpenCode event stream unavailable');
              if (shouldTriggerUpstreamHealthCheck(upstream)) {
                triggerHealthCheck?.();
              }
              return;
            }
            await wait(upstreamReconnectDelayMs);
            continue;
          }

          if (!streamReady) {
            sendMessageStreamWsFrame(socket, {
              type: 'ready',
              scope: isGlobalStream ? 'global' : 'directory',
            });
            streamReady = true;

            if (isGlobalStream) {
              wsClients.add(socket);
            }
          }

          upstreamConnected = true;
          const decoder = new TextDecoder();
          const reader = upstream.body.getReader();
          let buffer = '';
          let upstreamAbortReason = null;
          let stallTimer = null;
          const resetStallTimer = () => {
            if (stallTimer) {
              clearTimeout(stallTimer);
            }
            stallTimer = setTimeout(() => {
              upstreamAbortReason = 'upstream_stalled';
              upstreamConnected = false;
              upstreamController.abort();
            }, upstreamStallTimeoutMs);
          };

          resetStallTimer();

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                break;
              }

              resetStallTimer();
              buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

              let separatorIndex = buffer.indexOf('\n\n');
              while (separatorIndex !== -1) {
                const block = buffer.slice(0, separatorIndex);
                buffer = buffer.slice(separatorIndex + 2);
                forwardBlock(block);
                separatorIndex = buffer.indexOf('\n\n');
              }
            }

            if (buffer.trim().length > 0) {
              forwardBlock(buffer.trim());
            }
          } catch (error) {
            if (!controller.signal.aborted && upstreamAbortReason !== 'upstream_stalled') {
              console.warn('Message stream WS proxy error:', error);
            }
          } finally {
            if (stallTimer) {
              clearTimeout(stallTimer);
            }
            upstreamConnected = false;
            currentUpstreamAbortController = null;
            controller.signal.removeEventListener('abort', abortUpstream);
          }

          if (controller.signal.aborted) {
            return;
          }

          await wait(upstreamReconnectDelayMs);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn('Message stream WS proxy error:', error);
          sendMessageStreamWsFrame(socket, { type: 'error', message: 'Message stream proxy error' });
          socket.close(1011, 'Message stream proxy error');
        }
      } finally {
        cleanup();
        try {
          if (socket.readyState === 1 || socket.readyState === 0) {
            socket.close();
          }
        } catch {
        }
      }
    };

    void run();
  });

  const upgradeHandler = (req, socket, head) => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== MESSAGE_STREAM_GLOBAL_WS_PATH && pathname !== MESSAGE_STREAM_DIRECTORY_WS_PATH) {
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
      server.off('upgrade', upgradeHandler);

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
