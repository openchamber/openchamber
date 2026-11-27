import { readTrackerItemTarget, readTrimmedString, resolveHostEntryForRuntimeKey } from './notification-host-routing.mjs';

const PENDING_TRACKER_ITEM_TTL_MS = 60_000;

export const createTrackerItemClicks = ({
  app, getMainWindow, showWindow, emitToWindow, openMainWindow, openHostWindow, hostRoutingContext, isMainWindowReady, log, now = Date.now,
}) => {
  let pending = null;
  const hold = (target) => {
    pending = { target, at: now() };
  };
  const takePending = () => {
    const held = pending;
    pending = null;
    return held && now() - held.at < PENDING_TRACKER_ITEM_TTL_MS ? held.target : null;
  };
  const liveMainWindow = () => {
    const main = getMainWindow();
    return main && !main.isDestroyed() ? main : null;
  };

  const open = async (target) => {
    hold(target);
    const main = liveMainWindow();
    if (!main) {
      await openMainWindow();
      return;
    }
    const receivingKey = readTrimmedString(main.__ocRuntimeKey);
    if (!target.runtimeKey || !receivingKey || target.runtimeKey === receivingKey) {
      if (process.platform === 'darwin') app.focus({ steal: true });
      if (main.isMinimized()) main.restore();
      showWindow(main);
      main.focus();
    } else if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    if (isMainWindowReady()) emitToWindow(main, 'openchamber:tracker-item-waiting');
  };

  return {
    openFromNotification: (notification, done) => {
      const target = readTrackerItemTarget(notification);
      if (!target) return false;
      void open(target).catch((error) => {
        log.warn('[electron] failed to open the pull request of a notification:', error);
      });
      done();
      return true;
    },
    take: (browserWindow) => {
      const main = getMainWindow();
      if (!browserWindow || !main || browserWindow.id !== main.id) return null;
      return takePending();
    },
    openInHostWindow: async (args) => {
      const runtimeKey = readTrimmedString(args.runtimeKey);
      const target = readTrackerItemTarget({ itemUrl: args.url, directory: args.directory });
      if (!runtimeKey || !target) throw new Error('runtimeKey and an http(s) url are required');
      const host = resolveHostEntryForRuntimeKey(runtimeKey, hostRoutingContext());
      if (!host) {
        log.warn('[electron] open-host-tracker-item: no host for runtime key', { runtimeKey });
        return { opened: false };
      }
      await openHostWindow(host, { trackerItem: target }, { reuseOpenWindow: true });
      return { opened: true };
    },
  };
};
