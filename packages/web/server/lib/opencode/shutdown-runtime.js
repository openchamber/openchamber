export const createGracefulShutdownRuntime = (dependencies) => {
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
  } = dependencies;

  let shutdownPromise = null;
  const serverConnections = new Set();
  let closingHttpServer = false;

  const trackServerConnections = (server) => {
    const onConnection = (socket) => {
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

  const runShutdown = async (options = {}) => {
    if (getIsShuttingDown()) return;

    setIsShuttingDown(true);
    beginGuestServiceShutdown();
    extensionSessionEvents?.stop?.();
    extensionServiceLifetime?.stop?.();
    extensionWaitsRuntime?.stop?.();
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : getExitOnShutdown();

    const cleanupOperations = [
      () => clearInterval(getRelayReconcileTimer()),
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
        // One failed runtime must not skip the rest of host teardown.
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
      } finally {
        setTerminalRuntime(null);
      }
    }

    const messageStreamRuntime = getMessageStreamRuntime();
    if (messageStreamRuntime) {
      try {
        await messageStreamRuntime.close();
      } catch {
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

      killProcessOnPort(portToKill);
      if (!(await waitForPortRelease(portToKill, 5000))) {
        console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released during shutdown`);
      }
    } else {
      console.log('Skipping OpenCode shutdown (external server)');
    }

    const server = getServer();
    if (server) {
      closingHttpServer = true;
      let closeTimeout = null;
      try {
        await Promise.race([
          new Promise((resolve) => {
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
            server.closeAllConnections?.();
            for (const socket of serverConnections) socket.destroy();
          }),
          new Promise((resolve) => {
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

  const gracefulShutdown = (options = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown(options);
    return shutdownPromise;
  };

  return {
    gracefulShutdown,
    trackServerConnections,
  };
};
