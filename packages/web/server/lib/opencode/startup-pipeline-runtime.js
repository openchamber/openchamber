export const createStartupPipelineRuntime = (dependencies) => {
  const {
    createTerminalRuntime,
    createServerStartupRuntime,
  } = dependencies;

  const run = async (options) => {
    const {
      app,
      server,
      express,
      fs,
      path,
      uiAuthController,
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      terminalHeartbeatIntervalMs,
      terminalRebindWindowMs,
      terminalMaxRebindsPerWindow,
      setupProxy,
      scheduleOpenCodeApiDetection,
      bootstrapOpenCodeAtStartup,
      backendRegistry,
      getOpenCodeLifecycleState,
      staticRoutesRuntime,
      process,
      crypto,
      normalizeTunnelBootstrapTtlMs,
      readSettingsFromDiskMigrated,
      tunnelAuthController,
      startTunnelWithNormalizedRequest,
      gracefulShutdown,
      getSignalsAttached,
      setSignalsAttached,
      syncToHmrState,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
      host,
      port,
      startupTunnelRequest,
      onTunnelReady,
      tunnelRuntimeContext,
      attachSignals,
    } = options;

    const terminalRuntime = createTerminalRuntime({
      app,
      server,
      express,
      fs,
      path,
      uiAuthController,
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: terminalHeartbeatIntervalMs,
      TERMINAL_INPUT_WS_REBIND_WINDOW_MS: terminalRebindWindowMs,
      TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: terminalMaxRebindsPerWindow,
    });

    const defaultBackendId = await backendRegistry.getDefaultBackendId();
    const needsOpenCode = defaultBackendId === 'opencode'
      || !!process.env.OPENCODE_HOST
      || !!process.env.OPENCODE_BINARY
      || !!process.env.OPENCODE_PORT;

    // Always register proxy routes (they handle session merging for all backends),
    // but only bootstrap the OpenCode server process when needed.
    setupProxy(app);

    if (needsOpenCode) {
      // Optimistically mark OpenCode as available during boot so the proxy
      // shows the normal restarting/bootstrapping UX instead of skipping
      // OpenCode data entirely. The bootstrap callback will downgrade if
      // the binary actually fails to start.
      backendRegistry.setBackendAvailability('opencode', true);
      scheduleOpenCodeApiDetection();
      void bootstrapOpenCodeAtStartup().then(() => {
        // bootstrapOpenCodeAtStartup swallows its own startup errors, so
        // we must check the actual lifecycle state via the runtime getter.
        const runtimeState = getOpenCodeLifecycleState?.();
        const actuallyReady = runtimeState?.isOpenCodeReady ?? runtimeState?.openCodePort > 0;
        backendRegistry.setBackendAvailability('opencode', Boolean(actuallyReady));
        if (!actuallyReady) {
          console.log('OpenCode bootstrap completed but server is not ready; marking unavailable');
        }
      }).catch(() => {
        backendRegistry.setBackendAvailability('opencode', false);
      });
    } else {
      console.log(`Skipping OpenCode bootstrap (default backend: ${defaultBackendId})`);
      backendRegistry.setBackendAvailability('opencode', false);
    }

    // Codex is SDK-based and always available when registered
    backendRegistry.setBackendAvailability('codex', !!backendRegistry.getRuntime('codex'));

    staticRoutesRuntime.registerStaticRoutes(app);

    const serverStartupRuntime = createServerStartupRuntime({
      process,
      crypto,
      server,
      normalizeTunnelBootstrapTtlMs,
      readSettingsFromDiskMigrated,
      tunnelAuthController,
      startTunnelWithNormalizedRequest,
      gracefulShutdown,
      getSignalsAttached,
      setSignalsAttached,
      syncToHmrState,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
    });

    const bindHost = serverStartupRuntime.resolveBindHost(host);
    const startupResult = await serverStartupRuntime.startListeningAndMaybeTunnel({
      port,
      bindHost,
      startupTunnelRequest,
      onTunnelReady,
    });
    tunnelRuntimeContext.setActivePort(startupResult.activePort);

    serverStartupRuntime.attachProcessHandlers({ attachSignals });

    return {
      terminalRuntime,
    };
  };

  return {
    run,
  };
};
