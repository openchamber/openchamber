import { createTunnelService } from '../tunnels/index.js';
import { createTunnelRoutesRuntime } from '../tunnels/routes.js';

const printQuickTunnelWarning = () => {
  console.log(`
⚠️  Quick Tunnel Limitations:

   • Provider limits may apply
   • URLs are temporary and will expire when the tunnel stops
   • Quick tunnels are intended for ephemeral access, not persistent hosting
   • Password protection is required for tunnel access

   For production use, set up a persistent provider tunnel or static domain.
`);
};

export const createTunnelWiringRuntime = (dependencies) => {
  const {
    crypto,
    URL,
    tunnelProviderRegistry,
    tunnelAuthController,
    readSettingsFromDiskMigrated,
    readManagedRemoteTunnelConfigFromDisk,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    isSupportedTunnelMode,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_PRIVATE_NETWORK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TUNNEL_PROVIDER_TAILSCALE,
    TunnelServiceError,
    getActiveTunnelController,
    setActiveTunnelController,
    getRuntimeManagedRemoteTunnelHostname,
    setRuntimeManagedRemoteTunnelHostname,
    getRuntimeManagedRemoteTunnelToken,
    setRuntimeManagedRemoteTunnelToken,
  } = dependencies;

  const initialize = (app, initialPort) => {
    let activePort = initialPort;

    const tunnelService = createTunnelService({
      registry: tunnelProviderRegistry,
      getController: getActiveTunnelController,
      setController: setActiveTunnelController,
      getActivePort: () => activePort,
      onQuickTunnelWarning: () => {
        printQuickTunnelWarning();
      },
    });

    const tunnelRoutesRuntime = createTunnelRoutesRuntime({
      crypto,
      URL,
      tunnelService,
      tunnelProviderRegistry,
      tunnelAuthController,
      readSettingsFromDiskMigrated,
      readManagedRemoteTunnelConfigFromDisk,
      normalizeTunnelProvider,
      normalizeTunnelMode,
      normalizeOptionalPath,
      normalizeManagedRemoteTunnelHostname,
      normalizeTunnelBootstrapTtlMs,
      normalizeTunnelSessionTtlMs,
      isSupportedTunnelMode,
      upsertManagedRemoteTunnelToken,
      resolveManagedRemoteTunnelToken,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_PRIVATE_NETWORK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
      TUNNEL_PROVIDER_CLOUDFLARE,
      TUNNEL_PROVIDER_TAILSCALE,
      TunnelServiceError,
      getActivePort: () => activePort,
      getRuntimeManagedRemoteTunnelHostname,
      setRuntimeManagedRemoteTunnelHostname,
      getRuntimeManagedRemoteTunnelToken,
      setRuntimeManagedRemoteTunnelToken,
      getActiveTunnelController,
      setActiveTunnelController,
    });

    tunnelRoutesRuntime.registerRoutes(app);

    return {
      tunnelService,
      startTunnelWithNormalizedRequest: (...args) => tunnelRoutesRuntime.startTunnelWithNormalizedRequest(...args),
      getActivePort: () => activePort,
      setActivePort: (value) => {
        activePort = value;
      },
    };
  };

  return {
    initialize,
  };
};
