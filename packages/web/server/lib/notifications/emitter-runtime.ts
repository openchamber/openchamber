import type { NotificationPayload, NotificationUiEvent, SseWriter } from './contracts.js';

type DesktopNotificationHandler = (payload: NotificationPayload) => void;

interface NotificationEmitterDependencies {
  process: { stdout: SseWriter };
  getDesktopNotifyEnabled: () => boolean;
  desktopNotifyPrefix: string;
  getUiNotificationClients: () => Set<SseWriter>;
  getOpenChamberEventClients?: () => Set<SseWriter>;
  getBroadcastGlobalUiEvent?: () => ((event: NotificationUiEvent) => void) | null;
  onDesktopNotification?: DesktopNotificationHandler | null;
}

export const createNotificationEmitterRuntime = (dependencies: NotificationEmitterDependencies) => {
  const {
    process,
    getDesktopNotifyEnabled,
    desktopNotifyPrefix,
    getUiNotificationClients,
    getOpenChamberEventClients = () => new Set(),
    getBroadcastGlobalUiEvent,
    onDesktopNotification: initialOnDesktopNotification,
  } = dependencies;

  let onDesktopNotification = initialOnDesktopNotification ?? null;

  const setOnDesktopNotification = (cb: DesktopNotificationHandler | null) => {
    onDesktopNotification = cb;
  };

  const writeSseEvent = <Payload>(res: SseWriter, payload: Payload, serializedPayload = JSON.stringify(payload)) => {
    res.write(`data: ${serializedPayload}\n\n`);
  };

  const emitDesktopNotification = (payload: NotificationPayload | null | undefined) => {
    const desktopNotifyEnabled = getDesktopNotifyEnabled();
    if (!desktopNotifyEnabled) {
      return false;
    }

    if (!payload) {
      return false;
    }

    if (onDesktopNotification) {
      try {
        onDesktopNotification(payload);
        return true;
      } catch {
        return false;
      }
    }

    try {
      process.stdout.write(`${desktopNotifyPrefix}${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const broadcastUiNotification = (payload: NotificationPayload | null | undefined, options: { desktopNotificationDelivered?: boolean } = {}) => {
    const desktopNotifyEnabled = getDesktopNotifyEnabled();
    if (!payload) {
      return;
    }

    const desktopNotificationDelivered = options.desktopNotificationDelivered === true;

    const syntheticPayload: NotificationUiEvent = {
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
          continue;
        }
      }
    }

    const broadcastGlobalUiEvent = getBroadcastGlobalUiEvent?.() ?? null;
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
        continue;
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
