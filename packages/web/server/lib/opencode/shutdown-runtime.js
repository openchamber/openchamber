export const createGracefulShutdownRuntime = (dependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    sessionRuntime,
    sessionAssistRuntime,
    sessionGoalRuntime,
    contextObligatoryRuntime,
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
  } = dependencies;

  let shutdownPromise = null;

  const runShutdown = async (options = {}) => {
    if (getIsShuttingDown()) return;

    setIsShuttingDown(true);
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : getExitOnShutdown();

    openCodeWatcherRuntime.stop();
    sessionRuntime.dispose();
    sessionAssistRuntime?.stop?.();
    sessionGoalRuntime?.stop?.();
    contextObligatoryRuntime?.stop?.();
    scheduledTasksRuntime?.stop?.();

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
      const guardianManagedChild = openCodeProcess?.isGuardianManaged === true;
      const restartPreserveRequested = options.mode === 'restart'
        || options.preserveGuardian === true
        || options.restart === true;
      const preserveGuardianChild = restartPreserveRequested && guardianManagedChild;

      if (preserveGuardianChild) {
        console.log('Detaching from guardian-managed OpenCode for restart; guardian remains running.');
        try {
          if (typeof openCodeProcess.detach === 'function') {
            await openCodeProcess.detach();
          }
        } catch (error) {
          console.warn('Error detaching from guardian-managed OpenCode:', error);
        }
        setOpenCodeProcess(null);
        syncToHmrState();
      } else if (openCodeProcess) {
        console.log('Stopping OpenCode process...');
        if (guardianManagedChild) {
          if (typeof openCodeProcess.stopOwnedOpenCode !== 'function') {
            throw new Error('Guardian-managed OpenCode has no owner-scoped stop operation');
          }
          const stopped = await openCodeProcess.stopOwnedOpenCode();
          if (stopped === false) {
            throw new Error('Owner-scoped guardian OpenCode stop was not confirmed');
          }
        } else {
          try {
            await openCodeProcess.close();
          } catch (error) {
            console.warn('Error closing OpenCode process:', error);
          }
        }
        setOpenCodeProcess(null);
      }

      if (!restartPreserveRequested && !guardianManagedChild) {
        killProcessOnPort(portToKill);
        if (!(await waitForPortRelease(portToKill, 5000))) {
          console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released during shutdown`);
        }
      } else if (!restartPreserveRequested && guardianManagedChild && portToKill) {
        // Guardian ownership is authoritative. Never kill an arbitrary
        // listener on the OpenCode port when an owner-scoped stop failed;
        // the guardian can finish/rehydrate its own child safely.
        if (!(await waitForPortRelease(portToKill, 5000))) {
          console.warn(`Guardian-managed OpenCode port ${portToKill} remained occupied during shutdown`);
        }
      }
    } else {
      console.log('Skipping OpenCode shutdown (external server)');
    }

    const server = getServer();
    if (server) {
      let closeTimeout = null;
      try {
        await Promise.race([
          new Promise((resolve) => {
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
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
    shutdownPromise = runShutdown(options).catch((error) => {
      // An owner-scoped guardian stop is authoritative. If it fails, leave
      // the process proxy/instance metadata intact and allow a later startup
      // or explicit retry to recover the same owner/incarnation.
      shutdownPromise = null;
      setIsShuttingDown(false);
      syncToHmrState();
      throw error;
    });
    return shutdownPromise;
  };

  return {
    gracefulShutdown,
  };
};
