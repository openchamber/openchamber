import { sendMessageStreamWsEvent, sendMessageStreamWsFrame, sendSerializedMessageStreamWsFrame, serializeMessageStreamWsEvent } from './protocol.js';
import type { BridgeOptions, GlobalReadyFrame, InitialStreamError, StreamSocket } from './contracts.js';
import type { GlobalMessageStreamHub, ReplayEntry } from './global-hub.js';
import type { UpstreamResponse } from './upstream-reader.js';

interface GlobalBridgeOptions extends BridgeOptions {
  globalHub: GlobalMessageStreamHub;
  ownsGlobalHub: boolean;
}

function shouldTriggerUpstreamHealthCheck(upstream: UpstreamResponse | null) {
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
}: GlobalBridgeOptions) {
  const clients = new Set<StreamSocket>();
  const clientLastEventIds = new Map<StreamSocket, string>();
  const readyClients = new Set<StreamSocket>();

  const removeClient = (socket: StreamSocket) => {
    clients.delete(socket);
    clientLastEventIds.delete(socket);
    readyClients.delete(socket);
    wsClients.delete(socket);
  };

  const replayEvents = (socket: StreamSocket, entries: ReplayEntry[]) => {
    for (const entry of entries) {
      const sent = sendSerializedMessageStreamWsFrame(socket, entry.serializedFrame);
      if (!sent) {
        removeClient(socket);
        return;
      }
    }
  };

  const markReady = (socket: StreamSocket, requestedLastEventId: string) => {
    if (socket.readyState !== 1) {
      return;
    }

    globalHub.flushPending();
    const replay = globalHub.replayAfter(requestedLastEventId);
    const ready: GlobalReadyFrame = { type: 'ready', scope: 'global' };
    if (replay === null) ready.replayReset = true;
    else if (requestedLastEventId) ready.replayed = true;
    if (!ready.replayed) ready.cursor = globalHub.cursor();
    const sent = sendMessageStreamWsFrame(socket, ready);
    if (!sent) {
      removeClient(socket);
      return;
    }

    readyClients.add(socket);
    wsClients.add(socket);
    if (replay !== null) replayEvents(socket, replay);
  };

  const stopHubIfUnused = () => {
    if (ownsGlobalHub && clients.size === 0) {
      globalHub.stop();
    }
  };

  const closeClientsWithInitialError = ({ message, closeReason = message, triggerHealthCheckFor = null }: InitialStreamError) => {
    for (const socket of Array.from(clients)) {
      sendMessageStreamWsFrame(socket, { type: 'error', message });
      try {
        socket.close(1011, closeReason);
      } catch {
        void 0;
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

  const unsubscribeEvent = globalHub.subscribeEvent((event) => {
    const { payload } = event;
    for (const socket of Array.from(clients)) {
      if (!readyClients.has(socket)) {
        continue;
      }
      const sent = sendSerializedMessageStreamWsFrame(socket, event.serialize());
      if (!sent) {
        removeClient(socket);
      }
    }

    processForwardedEventPayload(payload, (syntheticPayload) => {
      if (readyClients.size === 0) return;
      const serializedFrame = serializeMessageStreamWsEvent(syntheticPayload, { directory: 'global' });
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          continue;
        }
        const sent = sendSerializedMessageStreamWsFrame(socket, serializedFrame);
        if (!sent) {
          removeClient(socket);
        }
      }
    }, { spaceId: event.spaceId });
  }, { spaces: true });

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
            cursor: globalHub.cursor(),
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

  const accept = (socket: StreamSocket, { requestedLastEventId = '' } = {}) => {
    const pingInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      try {
        socket.ping();
      } catch {
        void 0;
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
    if (globalHub.isConnected()) {
      markReady(socket, requestedLastEventId);
    }
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
