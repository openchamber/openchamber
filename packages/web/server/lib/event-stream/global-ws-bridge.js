import { sendMessageStreamWsEvent, sendMessageStreamWsFrame } from './protocol.js';

function shouldTriggerUpstreamHealthCheck(upstream) {
  if (!upstream) {
    return true;
  }

  if (!upstream.body) {
    return upstream.ok || upstream.status >= 500;
  }

  return upstream.status >= 500;
}

export function createGlobalMessageStreamWsBridge({
  globalHub,
  ownsGlobalHub,
  wsClients,
  processForwardedEventPayload,
  triggerHealthCheck,
  heartbeatIntervalMs,
}) {
  const clients = new Set();
  const clientLastEventIds = new Map();
  const readyClients = new Set();

  const removeClient = (socket) => {
    clients.delete(socket);
    clientLastEventIds.delete(socket);
    readyClients.delete(socket);
    wsClients.delete(socket);
  };

  const replayEvents = (socket, requestedLastEventId) => {
    for (const entry of globalHub.replayAfter(requestedLastEventId)) {
      const sent = sendMessageStreamWsEvent(socket, entry.payload, {
        directory: entry.directory,
        eventId: entry.eventId,
      });
      if (!sent) {
        removeClient(socket);
        return;
      }
    }
  };

  const markReady = (socket, requestedLastEventId) => {
    if (socket.readyState !== 1) {
      return;
    }

    const sent = sendMessageStreamWsFrame(socket, {
      type: 'ready',
      scope: 'global',
    });
    if (!sent) {
      removeClient(socket);
      return;
    }

    readyClients.add(socket);
    wsClients.add(socket);
    replayEvents(socket, requestedLastEventId);
  };

  const stopHubIfUnused = () => {
    if (ownsGlobalHub && clients.size === 0) {
      globalHub.stop();
    }
  };

  const closeClientsWithInitialError = ({ message, closeReason = message, triggerHealthCheckFor = null }) => {
    for (const socket of Array.from(clients)) {
      sendMessageStreamWsFrame(socket, { type: 'error', message });
      try {
        socket.close(1011, closeReason);
      } catch {
      }
      removeClient(socket);
    }

    if (triggerHealthCheckFor === true || (triggerHealthCheckFor && shouldTriggerUpstreamHealthCheck(triggerHealthCheckFor))) {
      triggerHealthCheck?.();
    }

    if (ownsGlobalHub) {
      globalHub.stop();
    }
  };

  const unsubscribeEvent = globalHub.subscribeEvent(({ payload, directory, eventId }) => {
    for (const socket of Array.from(clients)) {
      if (!readyClients.has(socket)) {
        continue;
      }
      const sent = sendMessageStreamWsEvent(socket, payload, {
        directory,
        eventId,
      });
      if (!sent) {
        removeClient(socket);
      }
    }

    processForwardedEventPayload(payload, (syntheticPayload) => {
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          continue;
        }
        const sent = sendMessageStreamWsEvent(socket, syntheticPayload, { directory: 'global' });
        if (!sent) {
          removeClient(socket);
        }
      }
    });
  });

  const unsubscribeStatus = globalHub.subscribeStatus((status) => {
    if (status.type === 'connect') {
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          markReady(socket, clientLastEventIds.get(socket) ?? '');
          continue;
        }

        if (status.wasReady) {
          const sent = sendMessageStreamWsFrame(socket, {
            type: 'ready',
            scope: 'global',
          });
          if (!sent) {
            removeClient(socket);
          }
        }
      }
      return;
    }

    if (status.type === 'initial-error') {
      const error = status.error;
      if (error?.type === 'upstream_unavailable') {
        closeClientsWithInitialError({
          message: `OpenCode event stream unavailable (${error.status})`,
          closeReason: 'OpenCode event stream unavailable',
          triggerHealthCheckFor: error.response,
        });
        return;
      }

      closeClientsWithInitialError({
        message: status.buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
        closeReason: status.buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
        triggerHealthCheckFor: !status.buildUrlFailed,
      });
      return;
    }

    if (status.type === 'error' && status.error?.type === 'stream_error') {
      console.warn('Message stream WS proxy error:', status.error.error);
    }
  });

  const accept = (socket, { requestedLastEventId = '' } = {}) => {
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
      if (!globalHub.isConnected()) {
        return;
      }

      sendMessageStreamWsEvent(socket, { type: 'openchamber:heartbeat', timestamp: Date.now() }, { directory: 'global' });
    }, heartbeatIntervalMs);

    socket.on('close', () => {
      clearInterval(pingInterval);
      clearInterval(heartbeatInterval);
      removeClient(socket);
      stopHubIfUnused();
    });

    socket.on('error', () => {
      void 0;
    });

    clients.add(socket);
    clientLastEventIds.set(socket, requestedLastEventId);
    globalHub.start();
    // FIX: Always mark the socket as ready immediately, regardless of whether
    // the upstream hub has finished connecting. Previously we gated this on
    // `globalHub.isConnected()`, which races the upstream SSE handshake:
    // the client's 2s WS-ready timeout fired before the server could send the
    // `ready` frame, triggering WS_FALLBACK and locking the client into
    // SSE-only mode for 60s on every page load. Events that arrive before the
    // upstream connects are buffered in the hub; new sockets that connect
    // after the hub is ready are still handled by the `status.type === 'connect'`
    // branch above. If the hub fails to connect at all, `unsubscribeStatus`
    // fires `closeClientsWithInitialError` which sends an `error` frame and
    // closes this socket with code 1011.
    markReady(socket, requestedLastEventId);
  };

  const close = () => {
    unsubscribeEvent();
    unsubscribeStatus();
    if (ownsGlobalHub) {
      globalHub.stop();
    }
    for (const socket of Array.from(clients)) {
      removeClient(socket);
    }
  };

  return {
    accept,
    close,
  };
}
