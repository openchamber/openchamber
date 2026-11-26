import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { isBoolean } from '../shared/object-guards.js';
import { stopActiveCommands } from '../fs/exec-command.js';

type Cleanup = () => void | Promise<void | object>;
type Stop = { stop: Cleanup };
type OptionalStop = Partial<Stop> | null;
type Close = { close: Cleanup };
type Timer = ReturnType<typeof setInterval>;

export interface ShutdownOptions {
  exitProcess?: boolean;
}

interface ShutdownDependencies {
  process: Pick<NodeJS.Process, 'exit'>;
  shutdownTimeoutMs: number;
  getExitOnShutdown: () => boolean;
  getIsShuttingDown: () => boolean;
  setIsShuttingDown: (value: boolean) => void;
  syncToHmrState: Cleanup;
  openCodeWatcherRuntime: Stop;
  chatDirectoryCleanupRuntime?: Stop | null;
  sessionRuntime: { dispose: Cleanup };
  sessionAssistRuntime?: OptionalStop;
  sessionWorkRuntime?: OptionalStop;
  sessionGoalRuntime?: OptionalStop;
  contextObligatoryRuntime?: OptionalStop;
  sessionWarmingRuntime?: OptionalStop;
  sessionTodosRuntime?: OptionalStop;
  autoReviewRuntime?: OptionalStop;
  prWatchRuntime?: OptionalStop;
  extensionWaitsRuntime?: OptionalStop;
  mergeFollowRuntime?: OptionalStop;
  messageQueueRuntime?: OptionalStop;
  dispatchResultsRuntime?: OptionalStop;
  workflowRuntime?: { shutdown: Cleanup } | null;
  messageSearchRuntime?: OptionalStop;
  scheduledTasksRuntime?: OptionalStop;
  getHealthCheckInterval: () => Timer | null;
  clearHealthCheckInterval: (value: Timer) => void;
  getTerminalRuntime: () => { shutdown: Cleanup } | null;
  setTerminalRuntime: (value: null) => void;
  getMessageStreamRuntime: () => Close | null;
  setMessageStreamRuntime: (value: null) => void;
  shouldSkipOpenCodeStop: () => boolean;
  getOpenCodePort: () => number | null;
  getOpenCodeProcess: () => Close | null;
  setOpenCodeProcess: (value: null) => void;
  killProcessOnPort: (port: number | null) => Promise<void>;
  waitForPortRelease: (port: number | null, timeoutMs: number) => Promise<boolean>;
  getServer: () => Server | null;
  getUiAuthController: () => { dispose: Cleanup } | null;
  setUiAuthController: (value: null) => void;
  getActiveTunnelController: () => Stop | null;
  setActiveTunnelController: (value: null) => void;
  tunnelAuthController: { clearActiveTunnel: Cleanup };
  beginGuestServiceShutdown: Cleanup;
  stopAllGuestServices: Cleanup;
  extensionServiceLifetime?: OptionalStop;
  extensionSessionEvents?: OptionalStop;
  getGuestSurfaceRuntime: () => Stop | null;
  getRealtimeProxyRuntime: () => Stop | null;
  getDictationRuntime: () => Stop | null;
  getRelayService: () => Stop | null;
  getRelayReconcileTimer: () => Timer | null;
  getSpacesHost?: () => Close | null;
  stopFolderWatches?: Cleanup;
  stopExecCommands?: Cleanup;
}

export const createGracefulShutdownRuntime = (dependencies: ShutdownDependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    chatDirectoryCleanupRuntime,
    sessionRuntime,
    sessionAssistRuntime,
    sessionWorkRuntime,
    sessionGoalRuntime,
    contextObligatoryRuntime,
    sessionWarmingRuntime,
    sessionTodosRuntime,
    autoReviewRuntime,
    prWatchRuntime,
    extensionWaitsRuntime = null,
    mergeFollowRuntime,
    messageQueueRuntime,
    dispatchResultsRuntime,
    workflowRuntime = null,
    messageSearchRuntime,
    scheduledTasksRuntime,
    getHealthCheckInterval,
    clearHealthCheckInterval,
    getTerminalRuntime,
    setTerminalRuntime,
    getMessageStreamRuntime,
    setMessageStreamRuntime,
    shouldSkipOpenCodeStop,
    getOpenCodePort,
    getOpenCodeProcess,
    setOpenCodeProcess,
    killProcessOnPort,
    waitForPortRelease,
    getServer,
    getUiAuthController,
    setUiAuthController,
    getActiveTunnelController,
    setActiveTunnelController,
    tunnelAuthController,
    beginGuestServiceShutdown,
    stopAllGuestServices,
    extensionServiceLifetime,
    extensionSessionEvents,
    getGuestSurfaceRuntime,
    getRealtimeProxyRuntime,
    getDictationRuntime,
    getRelayService,
    getRelayReconcileTimer,
    getSpacesHost = () => null,
    stopFolderWatches = () => {},
    stopExecCommands = stopActiveCommands,
  } = dependencies;

  let shutdownPromise: Promise<void> | null = null;
  const serverConnections = new Set<Socket>();
  let closingHttpServer = false;

  const trackServerConnections = (server: Server) => {
    const onConnection = (socket: Socket) => {
      if (closingHttpServer) {
        socket.destroy();
        return;
      }
      serverConnections.add(socket);
      socket.once('close', () => serverConnections.delete(socket));
    };
    server.on('connection', onConnection);
    server.once('close', () => server.off('connection', onConnection));
  };

  const runShutdown = async (options: ShutdownOptions = {}) => {
    if (getIsShuttingDown()) return;

    setIsShuttingDown(true);
    beginGuestServiceShutdown();
    extensionSessionEvents?.stop?.();
    extensionServiceLifetime?.stop?.();
    extensionWaitsRuntime?.stop?.();
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = isBoolean(options.exitProcess) ? options.exitProcess : getExitOnShutdown();

    const cleanupOperations = [
      stopExecCommands,
      () => clearInterval(getRelayReconcileTimer() ?? undefined),
      () => getGuestSurfaceRuntime()?.stop(),
      () => getRealtimeProxyRuntime()?.stop(),
      () => getSpacesHost()?.close(),
      () => getRelayService()?.stop(),
      () => getDictationRuntime()?.stop(),
      stopFolderWatches,
      () => chatDirectoryCleanupRuntime?.stop(),
      () => openCodeWatcherRuntime.stop(),
      () => sessionRuntime.dispose(),
      () => sessionAssistRuntime?.stop?.(),
      () => sessionWorkRuntime?.stop?.(),
      () => sessionGoalRuntime?.stop?.(),
      () => contextObligatoryRuntime?.stop?.(),
      () => sessionWarmingRuntime?.stop?.(),
      () => sessionTodosRuntime?.stop?.(),
      () => autoReviewRuntime?.stop?.(),
      () => prWatchRuntime?.stop?.(),
      () => mergeFollowRuntime?.stop?.(),
      () => messageQueueRuntime?.stop?.(),
      () => dispatchResultsRuntime?.stop?.(),
      () => workflowRuntime?.shutdown(),
      () => messageSearchRuntime?.stop?.(),
      () => scheduledTasksRuntime?.stop?.(),
      stopAllGuestServices,
    ];
    for (const cleanup of cleanupOperations) {
      try {
        await cleanup();
      } catch {
        continue;
      }
    }

    const healthCheckInterval = getHealthCheckInterval();
    if (healthCheckInterval) {
      clearHealthCheckInterval(healthCheckInterval);
    }

    const terminalRuntime = getTerminalRuntime();
    if (terminalRuntime) {
      try {
        await terminalRuntime.shutdown();
      } catch {
        void 0;
      } finally {
        setTerminalRuntime(null);
      }
    }

    const messageStreamRuntime = getMessageStreamRuntime();
    if (messageStreamRuntime) {
      try {
        await messageStreamRuntime.close();
      } catch {
        void 0;
      } finally {
        setMessageStreamRuntime(null);
      }
    }

    if (!shouldSkipOpenCodeStop()) {
      const portToKill = getOpenCodePort();
      const openCodeProcess = getOpenCodeProcess();

      if (openCodeProcess) {
        console.log('Stopping OpenCode process...');
        try {
          await openCodeProcess.close();
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        }
        setOpenCodeProcess(null);
      }

      await killProcessOnPort(portToKill);
      if (!(await waitForPortRelease(portToKill, 5000))) {
        console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released during shutdown`);
      }
    } else {
      console.log('Skipping OpenCode shutdown (external server)');
    }

    const server = getServer();
    if (server) {
      closingHttpServer = true;
      let closeTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
            server.closeAllConnections?.();
            for (const socket of serverConnections) socket.destroy();
          }),
          new Promise<void>((resolve) => {
            closeTimeout = setTimeout(() => {
              console.warn('Server close timeout reached, forcing shutdown');
              resolve();
            }, shutdownTimeoutMs);
          }),
        ]);
      } finally {
        if (closeTimeout) {
          clearTimeout(closeTimeout);
        }
      }
    }

    const uiAuthController = getUiAuthController();
    if (uiAuthController) {
      uiAuthController.dispose();
      setUiAuthController(null);
    }

    const activeTunnelController = getActiveTunnelController();
    if (activeTunnelController) {
      console.log('Stopping active tunnel...');
      activeTunnelController.stop();
      setActiveTunnelController(null);
      tunnelAuthController.clearActiveTunnel();
    }

    console.log('Graceful shutdown complete');
    if (exitProcess) {
      process.exit(0);
    }
  };

  const gracefulShutdown = (options: ShutdownOptions = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown(options);
    return shutdownPromise;
  };

  return {
    gracefulShutdown,
    trackServerConnections,
  };
};
