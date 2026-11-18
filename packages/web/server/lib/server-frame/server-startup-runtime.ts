import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isString } from '../shared/object-guards.js';
import type { createTunnelRoutesRuntime, NormalizedTunnelRouteRequest, TunnelRoutesDependencies } from '../tunnels/routes.js';

type TunnelStart = ReturnType<typeof createTunnelRoutesRuntime>['startTunnelWithNormalizedRequest'];
type StartupTunnelRequest = Omit<NormalizedTunnelRouteRequest, 'selectedPresetId' | 'selectedPresetName' | 'httpsPort'>;
type TunnelReady = (publicUrl: Awaited<ReturnType<TunnelStart>>['publicUrl'], connectUrl: string | null) => void;

export interface ServerStartupDependencies extends Pick<TunnelRoutesDependencies,
  'crypto' | 'normalizeTunnelBootstrapTtlMs' | 'readSettingsFromDiskMigrated' | 'tunnelAuthController'> {
  process: Pick<NodeJS.Process, 'env' | 'send' | 'connected' | 'on'>;
  server: Server;
  startTunnelWithNormalizedRequest: TunnelStart;
  gracefulShutdown: () => void | Promise<void>;
  getSignalsAttached: () => boolean;
  setSignalsAttached: (attached: boolean) => void;
  syncToHmrState: () => void;
  TUNNEL_MODE_QUICK: string;
  TUNNEL_MODE_MANAGED_LOCAL: string;
  TUNNEL_MODE_MANAGED_REMOTE: string;
}

export interface ListenOptions {
  port: number;
  bindHost: string;
  startupTunnelRequest: StartupTunnelRequest | null;
  onTunnelReady: TunnelReady | null;
}

const isIpcSend = (value: NodeJS.Process['send']): value is NonNullable<NodeJS.Process['send']> =>
  typeof value === 'function';

const isSocketAddress = (value: ReturnType<Server['address']>): value is AddressInfo =>
  typeof value === 'object' && value !== null;

const messageSource = (value: unknown): value is { message?: unknown } =>
  value !== null && value !== undefined;

const UNCAUGHT_STORM_LIMIT = 10;
const UNCAUGHT_STORM_WINDOW_MS = 60_000;

export const createServerStartupRuntime = (dependencies: ServerStartupDependencies) => {
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

  const resolveBindHost = (host: string | undefined) =>
    host
    || (isString(process.env.OPENCHAMBER_HOST) && process.env.OPENCHAMBER_HOST.trim().length > 0
      ? process.env.OPENCHAMBER_HOST.trim()
      : '127.0.0.1');

  const startListeningAndMaybeTunnel = async ({
    port,
    bindHost,
    startupTunnelRequest,
    onTunnelReady,
  }: ListenOptions) => {
    let activePort = port;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('error', onError);
        reject(error);
      };
      server.once('error', onError);
      const onListening = async () => {
        server.off('error', onError);
        try {
          const addressInfo = server.address();
          activePort = isSocketAddress(addressInfo) ? addressInfo.port : port;

          const send = process.send;
          if (isIpcSend(send)) {
            if (!process.connected) {
              throw new Error('OpenChamber startup IPC channel disconnected before ready notification');
            }

            await new Promise<void>((resolveReadyNotification, rejectReadyNotification) => {
              try {
                send.call(process, { type: 'openchamber:ready', port: activePort }, (error: Error | null) => {
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
              if (!messageSource(error)) {
                throw new TypeError(`Cannot read properties of ${error} (reading 'message')`);
              }
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

  const attachProcessHandlers = ({ attachSignals }: { attachSignals: boolean }) => {
    if (attachSignals && !getSignalsAttached()) {
      const handleSignal = async () => {
        await gracefulShutdown();
      };
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

    const exceptionTimes: number[] = [];
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      const now = Date.now();
      exceptionTimes.push(now);
      while (exceptionTimes.length > 0 && now - (exceptionTimes[0] ?? Number.NaN) > UNCAUGHT_STORM_WINDOW_MS) {
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
