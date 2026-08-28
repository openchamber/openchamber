/** One stray uncaught exception is survivable; a storm means the process is broken. */
const UNCAUGHT_STORM_LIMIT = 10;
const UNCAUGHT_STORM_WINDOW_MS = 60_000;

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
        try {
          const addressInfo = server.address();
          activePort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port;

          if (typeof process.send === 'function') {
            if (!process.connected) {
              throw new Error('OpenChamber startup IPC channel disconnected before ready notification');
            }

            await new Promise((resolveReadyNotification, rejectReadyNotification) => {
              try {
                process.send({ type: 'openchamber:ready', port: activePort }, (error) => {
                  if (error) {
                    rejectReadyNotification(error);
                    return;
                  }
                  resolveReadyNotification();
                });
              } catch (error) {
                rejectReadyNotification(error);
              }
            });
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
        } catch (error) {
          reject(error);
        }
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
      // Cover every signal a shell or dev harness may use to stop/restart us, so
      // the managed OpenCode child is always torn down gracefully instead of
      // orphaned: SIGINT/SIGQUIT (Ctrl+C/Ctrl+\), SIGTERM (kill/default), SIGHUP
      // (terminal close), SIGUSR2 (nodemon restart for `dev:server:watch`).
      process.on('SIGTERM', handleSignal);
      process.on('SIGINT', handleSignal);
      process.on('SIGQUIT', handleSignal);
      process.on('SIGHUP', handleSignal);
      process.on('SIGUSR2', handleSignal);
      setSignalsAttached(true);
      syncToHmrState();
    }

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    // A single stray exception — a socket teardown race, a Node-internal bug
    // like `setTypeOfService EINVAL` — must not take the server down. Nothing
    // restarts this process (it is embedded in the desktop app or run by hand
    // in a terminal), so shutting down turns every such stray into "the
    // instance is unreachable until I restart it". Mirror the
    // unhandledRejection policy above: log and keep serving. A sustained storm
    // of exceptions is a different situation — the process is genuinely
    // broken — so that still shuts down rather than limping along half-alive.
    const exceptionTimes = [];
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      const now = Date.now();
      exceptionTimes.push(now);
      while (exceptionTimes.length > 0 && now - exceptionTimes[0] > UNCAUGHT_STORM_WINDOW_MS) {
        exceptionTimes.shift();
      }
      if (exceptionTimes.length > UNCAUGHT_STORM_LIMIT) {
        console.error(`More than ${UNCAUGHT_STORM_LIMIT} uncaught exceptions within a minute; shutting down.`);
        gracefulShutdown();
      }
    });
  };

  return {
    resolveBindHost,
    startListeningAndMaybeTunnel,
    attachProcessHandlers,
  };
};
