export const createServerStartupRuntime = (dependencies) => {
  const {
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
  } = dependencies;

  const resolveBindHost = (host) =>
    host
    || (typeof process.env.OPENCHAMBER_HOST === 'string' && process.env.OPENCHAMBER_HOST.trim().length > 0
      ? process.env.OPENCHAMBER_HOST.trim()
      : '127.0.0.1');

  const startListeningAndMaybeTunnel = async ({
    port,
    bindHost,
    startupTunnelRequest,
    onTunnelReady,
  }) => {
    let activePort = port;

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('error', onError);
        reject(error);
      };
      server.once('error', onError);
      const onListening = async () => {
        server.off('error', onError);
        const addressInfo = server.address();
        activePort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port;

        try {
          process.send?.({ type: 'openchamber:ready', port: activePort });
        } catch {
          // ignore
        }

        const displayHost = (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]')
          ? 'localhost'
          : (bindHost.includes(':') ? `[${bindHost}]` : bindHost);
        console.log(`OpenChamber server listening on ${bindHost}:${activePort}`);
        console.log(`Health check: http://${displayHost}:${activePort}/health`);
        console.log(`Web interface: http://${displayHost}:${activePort}`);

        if (startupTunnelRequest) {
          const startupModeLabel = startupTunnelRequest.mode === TUNNEL_MODE_QUICK
            ? 'Quick Tunnel'
            : (startupTunnelRequest.mode === TUNNEL_MODE_MANAGED_LOCAL
              ? 'Managed Local Tunnel'
              : (startupTunnelRequest.mode === TUNNEL_MODE_MANAGED_REMOTE ? 'Managed Remote Tunnel' : 'Tunnel'));
          console.log(`\nInitializing ${startupModeLabel} for provider '${startupTunnelRequest.provider}'...`);
          try {
            const { publicUrl, mode } = await startTunnelWithNormalizedRequest({
              provider: startupTunnelRequest.provider,
              mode: startupTunnelRequest.mode,
              intent: startupTunnelRequest.intent,
              hostname: startupTunnelRequest.hostname,
              token: startupTunnelRequest.token,
              configPath: startupTunnelRequest.configPath,
              selectedPresetId: '',
              selectedPresetName: '',
            });
            if (publicUrl) {
              tunnelAuthController.setActiveTunnel({
                tunnelId: crypto.randomUUID(),
                publicUrl,
                mode,
              });
              const settings = await readSettingsFromDiskMigrated();
              const bootstrapTtlMs = settings?.tunnelBootstrapTtlMs === null
                ? null
                : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs);
              const bootstrapToken = tunnelAuthController.issueBootstrapToken({ ttlMs: bootstrapTtlMs });
              const connectUrl = `${publicUrl.replace(/\/$/, '')}/connect?t=${encodeURIComponent(bootstrapToken.token)}`;
              if (onTunnelReady) {
                onTunnelReady(publicUrl, connectUrl);
              } else {
                console.log(`\n🌐 Tunnel URL: ${connectUrl}`);
                console.log('🔑 One-time connect link (expires after first use)\n');
              }
            } else if (onTunnelReady) {
              onTunnelReady(publicUrl, null);
            }
          } catch (error) {
            console.error(`Failed to start tunnel: ${error.message}`);
            console.log('Continuing without tunnel...');
          }
        }

        resolve();
      };

      server.listen(port, bindHost, onListening);
    });

    return { activePort };
  };

  const attachProcessHandlers = ({ attachSignals }) => {
    if (attachSignals && !getSignalsAttached()) {
      const handleSignal = async () => {
        await gracefulShutdown();
      };
      process.on('SIGTERM', handleSignal);
      process.on('SIGINT', handleSignal);
      process.on('SIGQUIT', handleSignal);
      setSignalsAttached(true);
      syncToHmrState();
    }

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      gracefulShutdown();
    });
  };

  return {
    resolveBindHost,
    startListeningAndMaybeTunnel,
    attachProcessHandlers,
  };
};
