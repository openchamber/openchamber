export const createStartupPipelineRuntime = (dependencies) => {
  const {
    createTerminalRuntime,
    createMessageStreamWsRuntime,
    createServerStartupRuntime,
    createBrowserControlRuntime,
    ensureBrowserMcpRegistration,
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
      globalEventHub,
      processForwardedEventPayload,
      messageStreamWsClients,
      triggerHealthCheck,
      upstreamStallTimeoutMs,
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
      apiOnly,
      getBrowserPolicy,
      getBrowserMcpToken,
      requestOpenBrowser,
      browserMcp,
      browserMcpWorkingDirectory,
      refreshOpenCodeAfterConfigChange,
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
      globalEventHub,
      processForwardedEventPayload,
      wsClients: messageStreamWsClients,
      triggerHealthCheck,
      upstreamStallTimeoutMs,
    });

    // Agent-driven embedded browser control. Registered before setupProxy so the
    // MCP endpoint + WS routes match before the OpenCode /api/* forwarder.
    const browserControlRuntime = typeof createBrowserControlRuntime === 'function'
      ? createBrowserControlRuntime({
        app,
        server,
        express,
        uiAuthController,
        isRequestOriginAllowed,
        rejectWebSocketUpgrade,
        getBrowserPolicy,
        getBrowserMcpToken,
        requestOpenBrowser,
      })
      : null;

    setupProxy(app);
    scheduleOpenCodeApiDetection();
    void bootstrapOpenCodeAtStartup();

    if (apiOnly) {
      staticRoutesRuntime.registerApiOnlyFallbackRoutes(app);
    } else {
      staticRoutesRuntime.registerStaticRoutes(app);
    }

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

    // Idempotent, direct (non-route) registration of the managed browser MCP
    // entry now that the active loopback port is known. Writes only on drift and
    // only restarts OpenCode when something actually changed.
    if (browserControlRuntime && typeof ensureBrowserMcpRegistration === 'function' && browserMcp) {
      try {
        const policy = typeof getBrowserPolicy === 'function' ? getBrowserPolicy() : { enabled: false };
        const registration = ensureBrowserMcpRegistration({
          enabled: policy.enabled === true,
          port: startupResult.activePort,
          token: typeof getBrowserMcpToken === 'function' ? getBrowserMcpToken() : null,
          workingDirectory: browserMcpWorkingDirectory,
          mcp: browserMcp,
        });
        if (registration.changed && typeof refreshOpenCodeAfterConfigChange === 'function') {
          void refreshOpenCodeAfterConfigChange('browser mcp registration');
        }
      } catch (error) {
        console.warn('[BrowserControl] MCP registration failed:', error?.message || error);
      }
    }

    return {
      terminalRuntime,
      messageStreamRuntime,
      browserControlRuntime,
      activePort: startupResult.activePort,
    };
  };

  return {
    run,
  };
};
