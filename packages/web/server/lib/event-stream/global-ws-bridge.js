import { sendMessageStreamWsEvent, sendMessageStreamWsFrame, sendSerializedMessageStreamWsFrame, serializeMessageStreamWsEvent } from './protocol.js';
import { decodeOpenChamberCursor, isOpenCodeEventId } from './sse-cursor.js';

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
  // The last OpenCode id each client was sent, or the cursor it connected with until then. Hub ids
  // and payload ids are never kept: the browser keeps no cursor it could not replay from upstream.
  const clientLastEventIds = new Map();
  const readyClients = new Set();
  // The upstream read that resumes a client the replay buffer could not answer, while it runs.
  const resumeStops = new Map();

  // A `ready` frame names the stream's current cursor when OpenCode has sent an event. A browser that
  // holds no cursor adopts it, so its next reconnect resumes from there instead of refetching.
  const readyFrame = (fields = {}) => {
    const headCursor = globalHub.headEventId() ? globalHub.headCursor() : undefined;
    return { type: 'ready', scope: 'global', ...fields, ...(headCursor ? { headEventId: headCursor } : {}) };
  };

  const removeClient = (socket) => {
    clients.delete(socket);
    clientLastEventIds.delete(socket);
    readyClients.delete(socket);
    wsClients.delete(socket);
    resumeStops.get(socket)?.();
    resumeStops.delete(socket);
  };

  // The browser cursor is the versioned OpenChamber cursor of the last frame it applied. A legacy
  // OpenCode id is kept too, so an older browser can still take the upstream-only resume path.
  const rememberCursor = (socket, cursor) => {
    if (cursor) clientLastEventIds.set(socket, cursor);
  };

  const forwardEvent = (socket, event) => {
    if (!sendSerializedMessageStreamWsFrame(socket, event.serialize())) {
      removeClient(socket);
      return false;
    }
    if (event.position > 0) rememberCursor(socket, event.cursor());
    return true;
  };

  // An event the hub read from upstream on one client's own connection, forwarded the way the
  // shared stream forwards its events: with the synthetic events derived from it.
  const forwardUpstreamEvent = (socket, event) => {
    if (!forwardEvent(socket, event)) return false;
    processForwardedEventPayload(event.payload, (syntheticPayload) => {
      const serializedFrame = serializeMessageStreamWsEvent(syntheticPayload, { directory: 'global' });
      if (!sendSerializedMessageStreamWsFrame(socket, serializedFrame)) {
        removeClient(socket);
      }
    });
    return clients.has(socket);
  };

  const forwardReplayEntry = (socket, entry) => {
    if (!sendSerializedMessageStreamWsFrame(socket, entry.serializedFrame)) {
      removeClient(socket);
      return false;
    }
    rememberCursor(socket, entry.cursor);
    return true;
  };

  const replayEvents = (socket, entries) => {
    for (const entry of entries) {
      if (!forwardReplayEntry(socket, entry)) return false;
    }
    return true;
  };

  const sendReady = (socket, fields) => {
    const sent = sendMessageStreamWsFrame(socket, readyFrame(fields));
    if (!sent) {
      removeClient(socket);
      return false;
    }
    return true;
  };

  const resetReady = (socket) => {
    if (!sendReady(socket, { replayReset: true })) return;
    readyClients.add(socket);
    wsClients.add(socket);
  };

  // The client is ready once the buffer or OpenCode has answered its cursor. A versioned cursor the
  // buffer cannot answer either has durable local frames to replay and an upstream id to read from,
  // or it is reset. A legacy OpenCode id keeps the old upstream-only path, and only while no local
  // frame is known: OpenCode cannot replay one, so a resume could skip it.
  const markReady = (socket, requestedLastEventId) => {
    if (socket.readyState !== 1) {
      return;
    }

    globalHub.flushPending();
    const cursor = decodeOpenChamberCursor(requestedLastEventId);
    const replay = cursor
      ? globalHub.replayAfterCursor(cursor)
      : globalHub.replayAfter(requestedLastEventId);

    if (replay !== null) {
      const resumed = cursor !== null || isOpenCodeEventId(requestedLastEventId);
      if (!sendReady(socket, resumed ? { resumed: true } : {})) return;
      readyClients.add(socket);
      wsClients.add(socket);
      replayEvents(socket, replay);
      return;
    }

    if (cursor) {
      if (cursor.stream !== globalHub.streamId()) {
        resetReady(socket);
        return;
      }
      const plan = globalHub.durableResumePlan(cursor);
      if (!plan) {
        resetReady(socket);
        return;
      }
      if (plan.kind === 'locals') {
        // No upstream id was ever applied, so there is nothing to read. The durable local frames
        // fill the gap and the buffer carries everything committed after it.
        if (!sendReady(socket, { resumed: true })) return;
        readyClients.add(socket);
        wsClients.add(socket);
        if (!replayEvents(socket, plan.entries)) return;
        replayEvents(socket, globalHub.replayEntries());
        return;
      }
      resumeFromUpstream(socket, plan.upstream, plan.entries);
      return;
    }

    if (isOpenCodeEventId(requestedLastEventId) && globalHub.localFrames() === 0) {
      resumeFromUpstream(socket, requestedLastEventId, []);
      return;
    }

    resetReady(socket);
  };

  // The buffer cannot answer a cursor, but OpenCode may: the events after the cursor are read on a
  // connection of this client's own and go out as they come, until the first one the hub also holds.
  // Durable local frames are interleaved after the upstream frame they followed. The client is told
  // it resumed at once, as it is after a replay. If OpenCode cannot honour the cursor, it is told to
  // refetch instead, and then it is live like any other client.
  const resumeFromUpstream = (socket, cursor, durableLocals) => {
    if (!sendReady(socket, { resumed: true })) return;

    let pendingLocals = durableLocals.slice();
    const takeLocalsFor = (anchor) => {
      const remaining = [];
      for (const entry of pendingLocals) {
        if (entry.upstream === anchor) {
          if (!forwardReplayEntry(socket, entry)) return false;
        } else {
          remaining.push(entry);
        }
      }
      pendingLocals = remaining;
      return clients.has(socket);
    };

    const goLive = () => {
      readyClients.add(socket);
      wsClients.add(socket);
    };
    const refetch = () => {
      resumeStops.delete(socket);
      if (!clients.has(socket)) return;
      resetReady(socket);
    };

    // Local frames that followed the cursor's own upstream frame come before the first event the
    // read delivers.
    if (!takeLocalsFor(cursor)) return;

    const stop = globalHub.openUpstreamAfter(cursor, {
      onEvent(event) {
        if (!clients.has(socket)) return;
        if (!forwardUpstreamEvent(socket, event)) return;
        takeLocalsFor(event.eventId);
      },
      onCaughtUp(event) {
        resumeStops.delete(socket);
        if (!clients.has(socket) || !forwardUpstreamEvent(socket, event)) return;
        takeLocalsFor(event.eventId);
        // Any local frame still waiting belongs to an upstream frame the read did not deliver; its
        // order relative to the buffer tail cannot be proven, so the client refetches.
        if (pendingLocals.length > 0) {
          refetch();
          return;
        }
        const tail = globalHub.replayAfter(event.eventId);
        if (tail === null) {
          refetch();
          return;
        }
        replayEvents(socket, tail);
        if (clients.has(socket)) goLive();
      },
      // OpenCode had nothing after the cursor, so the client is current: it goes live with nothing to
      // replay. Events committed from here on reach it through the shared stream.
      onIdle() {
        resumeStops.delete(socket);
        if (!clients.has(socket)) return;
        if (pendingLocals.length > 0) {
          refetch();
          return;
        }
        goLive();
      },
      onResync: refetch,
      onFailed: refetch,
    });
    resumeStops.set(socket, stop);
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

  // Browser clients take the events of isolated spaces too: each frame carries its directory,
  // and a space's directory is one more project directory to the UI.
  const unsubscribeEvent = globalHub.subscribeEvent((event) => {
    if (event.resync) {
      // OpenCode could not honour the cursor: the ready clients refetch, as after a replay reset.
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          continue;
        }
        if (!sendMessageStreamWsFrame(socket, readyFrame({ replayReset: true }))) {
          removeClient(socket);
        }
      }
      return;
    }

    const { payload } = event;
    for (const socket of Array.from(clients)) {
      if (!readyClients.has(socket)) {
        continue;
      }
      forwardEvent(socket, event);
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
          // A client still resuming from upstream keeps its own read; it is not marked again.
          if (!resumeStops.has(socket)) markReady(socket, clientLastEventIds.get(socket) ?? '');
          continue;
        }

        if (status.wasReady) {
          // The upstream reconnects from its own cursor, so what it missed is replayed; without an
          // OpenCode cursor there is nothing to replay from, and the client must refetch as before.
          const ready = readyFrame();
          if (isOpenCodeEventId(globalHub.upstreamCursor())) ready.resumed = true;
          const sent = sendMessageStreamWsFrame(socket, ready);
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
    /** The id of the last upstream event sent to a client, or the cursor it connected with. */
    lastEventIdOf(socket) {
      return clientLastEventIds.get(socket);
    },
  };
}
