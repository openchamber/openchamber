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
      autoUpdatePlugins,
      refreshOpenCodeAfterConfigChange,
      autoUpdatePlugins,
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

    setupProxy(app);
    scheduleOpenCodeApiDetection();
    void bootstrapOpenCodeAtStartup();

    // Auto-update npm plugins after bootstrap (fire-and-forget)
    if (autoUpdatePlugins) {
      void (async () => {
        try {
          const results = await autoUpdatePlugins(null);
          if (results.length > 0) {
            const updated = results.filter((r) => r.success).length;
            const actuallyChanged = results.filter((r) => r.success && r.toVersion).length;
            console.log(`[Plugin Auto-Update] Updated ${updated}/${results.length} plugins`);
            for (const result of results) {
              if (result.success) {
                console.log(`  ✓ ${result.spec} → ${result.toVersion}`);
              } else {
                console.log(`  ✗ ${result.spec}: ${result.error}`);
              }
            }
            // Reload OpenCode to pick up updated plugin specs
            if (actuallyChanged > 0 && typeof refreshOpenCodeAfterConfigChange === 'function') {
              try {
                await refreshOpenCodeAfterConfigChange('plugin auto-update');
                console.log('[Plugin Auto-Update] OpenCode reloaded');
              } catch (reloadError) {
                console.error('[Plugin Auto-Update] Failed to reload OpenCode:', reloadError);
              }
            }
          }
        } catch (error) {
          console.error('[Plugin Auto-Update] Failed:', error);
        }
      })();
    }

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

    return {
      terminalRuntime,
      messageStreamRuntime,
    };
  };

  return {
    run,
  };
};
