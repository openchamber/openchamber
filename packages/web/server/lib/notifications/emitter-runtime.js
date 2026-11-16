export const createNotificationEmitterRuntime = (dependencies) => {
  const {
    process,
    getDesktopNotifyEnabled,
    desktopNotifyPrefix,
    getUiNotificationClients,
    getOpenChamberEventClients = () => new Set(),
    getBroadcastGlobalUiEvent,
    onDesktopNotification: initialOnDesktopNotification,
  } = dependencies;

  let onDesktopNotification = typeof initialOnDesktopNotification === 'function'
    ? initialOnDesktopNotification
    : null;

  const setOnDesktopNotification = (cb) => {
    onDesktopNotification = typeof cb === 'function' ? cb : null;
  };

  const writeSseEvent = (res, payload, serializedPayload = JSON.stringify(payload)) => {
    res.write(`data: ${serializedPayload}\n\n`);
  };

  const emitDesktopNotification = (payload) => {
    const desktopNotifyEnabled = getDesktopNotifyEnabled();
    if (!desktopNotifyEnabled) {
      return false;
    }

    if (!payload || typeof payload !== 'object') {
      return false;
    }

    if (onDesktopNotification) {
      try {
        onDesktopNotification(payload);
        return true;
      } catch {
        // ignore host-side throw
      }
      return false;
    }

    try {
      process.stdout.write(`${desktopNotifyPrefix}${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      // ignore
    }

    return false;
  };

  const broadcastUiNotification = (payload, options = {}) => {
    const desktopNotifyEnabled = getDesktopNotifyEnabled();
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const desktopNotificationDelivered = options.desktopNotificationDelivered === true;

    const syntheticPayload = {
      type: 'openchamber:notification',
      properties: {
        ...payload,
        desktopNotificationDelivered,
        desktopStdoutActive: desktopNotifyEnabled,
      },
    };

    const controlClients = getOpenChamberEventClients();
    if (controlClients.size > 0) {
      const serializedPayload = JSON.stringify(syntheticPayload);
      for (const client of controlClients) {
        try {
          writeSseEvent(client, syntheticPayload, serializedPayload);
        } catch {
          // One disconnected control client must not block other transports.
        }
      }
    }

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

    const serializedPayload = JSON.stringify(syntheticPayload);
    for (const res of clients) {
      try {
        writeSseEvent(res, syntheticPayload, serializedPayload);
      } catch {
        // ignore
      }
    }
  };

  return {
    writeSseEvent,
    emitDesktopNotification,
    broadcastUiNotification,
    setOnDesktopNotification,
  };
};
