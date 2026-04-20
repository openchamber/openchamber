export const createStartupPipelineRuntime = (dependencies) => {
  const {
    createTerminalRuntime,
    createMessageStreamWsRuntime,
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
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      processForwardedEventPayload,
      messageStreamWsClients,
      triggerHealthCheck,
      terminalHeartbeatIntervalMs,
      terminalRebindWindowMs,
      terminalMaxRebindsPerWindow,
      setupProxy,
      scheduleOpenCodeApiDetection,
      bootstrapOpenCodeAtStartup,
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

    const messageStreamRuntime = createMessageStreamWsRuntime({
      server,
      uiAuthController,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      processForwardedEventPayload,
      wsClients: messageStreamWsClients,
      triggerHealthCheck,
    });

    setupProxy(app);
    scheduleOpenCodeApiDetection();
    void bootstrapOpenCodeAtStartup();

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
      messageStreamRuntime,
    };
  };

  return {
    run,
  };
};
