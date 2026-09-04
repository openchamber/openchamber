import { sendMessageStreamWsEvent, sendMessageStreamWsFrame } from './protocol.js';
import { createUpstreamSseReader } from './upstream-reader.js';
import { createOpenCode2EventNormalizer } from './opencode2-event-normalizer.js';

function shouldTriggerUpstreamHealthCheck(upstream) {
  if (!upstream) {
    return true;
  }

  if (!upstream.body) {
    return upstream.ok || upstream.status >= 500;
  }

  return upstream.status >= 500;
}

export function acceptDirectoryMessageStreamWsConnection({
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
  getOpenCodeProtocol = () => 'legacy',
}) {
  const controller = new AbortController();
  const opencode2Normalizer = createOpenCode2EventNormalizer();
  let upstreamConnected = false;
  let streamReady = false;
  let reader = null;

  const cleanup = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    reader?.stop();
    opencode2Normalizer.reset();
    wsClients.delete(socket);
  };

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
    const forwardEvent = ({ envelope, payload }) => {
      const normalized = getOpenCodeProtocol() === 'opencode2'
        ? opencode2Normalizer.normalize({
          envelope: {
            ...envelope,
            ...(requestedDirectory && !envelope?.directory ? { directory: requestedDirectory } : {}),
          },
          payload,
        })
        : { envelope, payload, directory: envelope?.directory || 'global', eventId: envelope?.eventId };
      if (!normalized) {
        return;
      }

      const directory = normalized.directory !== 'global'
        ? normalized.directory
        : requestedDirectory || envelope?.directory || 'global';

      sendMessageStreamWsEvent(socket, normalized.payload, {
        directory,
        eventId: normalized.eventId,
      });

      processForwardedEventPayload(normalized.payload, (syntheticPayload) => {
        sendMessageStreamWsEvent(socket, syntheticPayload, { directory: 'global' });
      });
    };

    try {
      let buildUrlFailed = false;
      const closeWithInitialError = ({ message, closeReason = message, triggerHealthCheckFor = null }) => {
        sendMessageStreamWsFrame(socket, { type: 'error', message });
        socket.close(1011, closeReason);
        if (triggerHealthCheckFor === true || (triggerHealthCheckFor && shouldTriggerUpstreamHealthCheck(triggerHealthCheckFor))) {
          triggerHealthCheck?.();
        }
        reader?.stop();
        cleanup();
      };

      reader = createUpstreamSseReader({
        initialLastEventId: requestedLastEventId,
        signal: controller.signal,
        stallTimeoutMs: upstreamStallTimeoutMs,
        reconnectDelayMs: upstreamReconnectDelayMs,
        fetchImpl,
        buildUrl: () => {
          buildUrlFailed = false;
          let targetUrl;
          try {
            const eventPath = getOpenCodeProtocol() === 'opencode2' ? '/api/event' : '/event';
            targetUrl = new URL(buildOpenCodeUrl(eventPath, ''));
          } catch {
            buildUrlFailed = true;
            throw new Error('OpenCode service unavailable');
          }

          if (requestedDirectory) {
            targetUrl.searchParams.set('directory', requestedDirectory);
          }

          return targetUrl;
        },
        getHeaders: getOpenCodeAuthHeaders,
        onConnect() {
          if (!streamReady) {
            sendMessageStreamWsFrame(socket, {
              type: 'ready',
              scope: 'directory',
            });
            streamReady = true;
          }

          upstreamConnected = true;
        },
        onDisconnect() {
          upstreamConnected = false;
        },
        onEvent: forwardEvent,
        onError(error) {
          if (controller.signal.aborted) {
            return;
          }

          if (!streamReady) {
            if (error?.type === 'upstream_unavailable') {
              closeWithInitialError({
                message: `OpenCode event stream unavailable (${error.status})`,
                closeReason: 'OpenCode event stream unavailable',
                triggerHealthCheckFor: error.response,
              });
              return;
            }

            closeWithInitialError({
              message: buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
              closeReason: buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
              triggerHealthCheckFor: !buildUrlFailed,
            });
            return;
          }

          if (error?.type === 'stream_error') {
            console.warn('Message stream WS proxy error:', error.error);
          }
        },
      });

      await reader.start();
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
}
