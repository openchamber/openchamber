export const createNotificationEmitterRuntime = (dependencies) => {
  const {
    process,
    getDesktopNotifyEnabled,
    desktopNotifyPrefix,
    getUiNotificationClients,
    getBroadcastGlobalUiEvent,
  } = dependencies;

  const writeSseEvent = (res, payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const emitDesktopNotification = (payload) => {
    const desktopNotifyEnabled = getDesktopNotifyEnabled();
    if (!desktopNotifyEnabled) {
      return;
    }

    if (!payload || typeof payload !== 'object') {
      return;
    }

    try {
      // One-line protocol consumed by the Tauri shell.
      process.stdout.write(`${desktopNotifyPrefix}${JSON.stringify(payload)}\n`);
    } catch {
      // ignore
    }
  };

  const broadcastUiNotification = (payload) => {
    const desktopNotifyEnabled = getDesktopNotifyEnabled();
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const syntheticPayload = {
      type: 'openchamber:notification',
      properties: {
        ...payload,
        // Tell the UI whether the sidecar stdout notification channel is active.
        // When true, the desktop UI should skip this SSE notification to avoid duplicates.
        // When false (e.g. tauri dev), the UI must handle this SSE notification itself.
        desktopStdoutActive: desktopNotifyEnabled,
      },
    };

    const broadcastGlobalUiEvent = typeof getBroadcastGlobalUiEvent === 'function'
      ? getBroadcastGlobalUiEvent()
      : null;
    if (broadcastGlobalUiEvent) {
      broadcastGlobalUiEvent(syntheticPayload);
      return;
    }

    const clients = getUiNotificationClients();
    if (clients.size === 0) {
      return;
    }

    for (const res of clients) {
      try {
        writeSseEvent(res, syntheticPayload);
      } catch {
        // ignore
      }
    }
  };

  return {
    writeSseEvent,
    emitDesktopNotification,
    broadcastUiNotification,
  };
};
