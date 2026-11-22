import net from 'node:net';

// How long a handoff leaves idle keep-alive sockets open, so each can take one more request with
// `Connection: close` before it is closed. Long enough for a client polling every few milliseconds.
const HANDOFF_IDLE_GRACE_MS = 1000;
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { isBoolean } from '../shared/object-guards.js';

type Cleanup = () => void | Promise<void | object>;
type Stop = { stop: Cleanup };
type OptionalStop = Partial<Stop> | null;
type Close = { close: Cleanup };
type Timer = ReturnType<typeof setInterval>;

export interface ShutdownOptions {
  exitProcess?: boolean;
  // A self-handoff successor already serves this socket.
  handoff?: boolean;
  // A supervisor stop (SIGTERM) leaves OpenCode running for the next start.
  keepOpenCode?: boolean;
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
  goalSpecJobRuntime?: OptionalStop;
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
  waitForPortRelease: (port: number | null, timeoutMs: number) => Promise<boolean>;
  // Closes OpenCode processes left draining by a handoff (draining-opencode.js).
  closeDrainingOpenCode?: () => void | Promise<unknown>;
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
    goalSpecJobRuntime,
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
    waitForPortRelease,
    closeDrainingOpenCode,
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
  } = dependencies;

  let shutdownPromise: Promise<void> | null = null;
  const serverConnections = new Set<Socket>();
  const busySocketRequests = new Map<Socket, number>();
  let closingHttpServer = false;
  // Set once this process has stopped accepting. Requests already on open connections still get
  // answers, each with `Connection: close`, so keep-alive clients move to whichever process accepts next.
  let acceptingStopped = false;
  let listenerClosed: Promise<boolean> | null = null;

  const trackServerConnections = (server: Server) => {
    const onConnection = (socket: Socket) => {
      if (closingHttpServer) {
        socket.destroy();
        return;
      }
      serverConnections.add(socket);
      socket.once('close', () => {
        serverConnections.delete(socket);
        busySocketRequests.delete(socket);
      });
    };
    const onRequest = (request: IncomingMessage, response: ServerResponse) => {
      const socket = request.socket;
      if (acceptingStopped) response.setHeader('Connection', 'close');
      busySocketRequests.set(socket, (busySocketRequests.get(socket) ?? 0) + 1);
      response.once('close', () => {
        const remaining = (busySocketRequests.get(socket) ?? 1) - 1;
        if (remaining > 0) busySocketRequests.set(socket, remaining);
        else busySocketRequests.delete(socket);
      });
    };
    server.on('connection', onConnection);
    server.on('request', onRequest);
    server.once('close', () => {
      server.off('connection', onConnection);
      server.off('request', onRequest);
    });
  };

  // Stops this process from accepting. When a successor holds the same listening socket, the socket
  // stays open and connections queued in the kernel go to the successor.
  // With keepIdleConnections, only the listener closes: http.Server.close() would also destroy idle
  // keep-alive sockets at once, and a client may be writing on one of them at that moment. Those sockets
  // instead answer their next request with `Connection: close`, and the drain closes them after a grace.
  const stopAccepting = (server: Server, { keepIdleConnections = false } = {}) => {
    acceptingStopped = true;
    if (!listenerClosed) {
      listenerClosed = new Promise<boolean>((resolve) => {
        const onClosed = () => {
          console.log('HTTP server closed');
          resolve(true);
        };
        if (keepIdleConnections) net.Server.prototype.close.call(server, onClosed);
        else server.close(onClosed);
      });
    }
    return listenerClosed;
  };

  // Stops accepting connections, then lets sockets with an in-flight HTTP request finish for up to
  // shutdownTimeoutMs. Idle keep-alive and upgraded sockets are cut at once, or after idleGraceMs on a
  // handoff: their owning runtimes were stopped above, and net.Server.close() cannot complete while an
  // upgraded socket is open.
  const drainHttpServer = async (server: Server, { idleGraceMs = 0 } = {}) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const closed = stopAccepting(server, { keepIdleConnections: idleGraceMs > 0 });
    const idleSweepAt = Date.now() + idleGraceMs;
    const sweepIdleSockets = () => {
      if (Date.now() < idleSweepAt) return;
      server.closeIdleConnections?.();
      for (const socket of serverConnections) {
        if (!busySocketRequests.has(socket)) socket.destroy();
      }
    };
    sweepIdleSockets();
    const sweepTimer = setInterval(sweepIdleSockets, 100);
    const drained = await Promise.race([
      closed,
      new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(false), shutdownTimeoutMs);
      }),
    ]);
    clearInterval(sweepTimer);
    clearTimeout(graceTimer);
    if (!drained) {
      console.warn('Server close timeout reached, forcing shutdown');
      server.closeAllConnections?.();
      for (const socket of serverConnections) socket.destroy();
    }
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

    // A handoff stops accepting before any runtime stops, so no new request reaches a stopped runtime.
    // The successor already serves this socket; only requests on open connections still come here.
    const server = getServer();
    const handoff = options.handoff === true;
    if (handoff && server) stopAccepting(server, { keepIdleConnections: true });

    const cleanupOperations = [
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
      () => goalSpecJobRuntime?.stop?.(),
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

    if (shouldSkipOpenCodeStop()) {
      console.log('Skipping OpenCode shutdown (external server)');
    } else if (options.keepOpenCode) {
      console.log('Leaving OpenCode running for the next start to adopt');
    } else {
      await closeDrainingOpenCode?.();
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

      if (!(await waitForPortRelease(portToKill, 5000))) {
        console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released during shutdown`);
      }
    }

    if (server) {
      closingHttpServer = true;
      await drainHttpServer(server, { idleGraceMs: handoff ? HANDOFF_IDLE_GRACE_MS : 0 });
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
