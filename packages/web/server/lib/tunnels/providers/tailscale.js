import {
  checkTailscaleAvailable,
  checkTailscaleStatus,
  startTailscaleTunnel,
} from '../../tailscale-tunnel.js';
import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PRIVATE_NETWORK,
  TUNNEL_MODE_PRIVATE_NETWORK,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_TAILSCALE,
  TunnelServiceError,
} from '../types.js';
import { getTunnelDependencyInstallInfo } from '../install-help.js';

export const tailscaleTunnelProviderCapabilities = {
  provider: TUNNEL_PROVIDER_TAILSCALE,
  defaults: {
    mode: TUNNEL_MODE_PRIVATE_NETWORK,
    optionDefaults: {},
  },
  modes: [
    {
      key: TUNNEL_MODE_PRIVATE_NETWORK,
      label: 'Private Network (Serve)',
      intent: TUNNEL_INTENT_PRIVATE_NETWORK,
      requires: [],
      supports: ['sessionTTL', 'httpsPort'],
      stability: 'beta',
    },
    {
      key: TUNNEL_MODE_QUICK,
      label: 'Quick Tunnel (Funnel)',
      intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC,
      requires: [],
      supports: ['sessionTTL', 'httpsPort'],
      stability: 'beta',
    },
  ],
};

export function createTailscaleTunnelProvider() {
  return {
    id: TUNNEL_PROVIDER_TAILSCALE,
    capabilities: tailscaleTunnelProviderCapabilities,
    checkAvailability: async () => {
      const result = await checkTailscaleAvailable();
      const installInfo = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_TAILSCALE);
      return result.available
        ? { ...installInfo, ...result, message: null }
        : { ...installInfo, ...result, message: result.message || installInfo.message };
    },
    diagnose: async () => {
      const dependency = await checkTailscaleAvailable();
      const installInfo = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_TAILSCALE);
      const status = dependency.available
        ? await checkTailscaleStatus({ tailscalePath: dependency.path })
        : {
          ready: false,
          blocker: 'install',
          detail: dependency.message || installInfo.message,
        };
      const startupReady = dependency.available && status.ready;
      const providerChecks = [
        {
          id: 'dependency',
          label: 'tailscale installed',
          status: dependency.available ? 'pass' : 'fail',
          detail: dependency.available
            ? (dependency.version || dependency.path || 'tailscale available')
            : (dependency.message || installInfo.message),
        },
        {
          id: 'status',
          label: 'Tailscale daemon and authentication',
          status: status.ready ? 'pass' : 'fail',
          detail: status.detail,
        },
      ];
      const modeChecks = tailscaleTunnelProviderCapabilities.modes.map((descriptor) => ({
        mode: descriptor.key,
        checks: [
          {
            id: 'startup_readiness',
            label: 'Provider startup readiness',
            status: startupReady ? 'pass' : 'fail',
            detail: startupReady
              ? 'Tailscale CLI, daemon, and authentication checks passed.'
              : (status.detail || 'Resolve Tailscale provider checks before starting tunnels.'),
          },
        ],
        summary: {
          ready: startupReady,
          failures: startupReady ? 0 : 1,
          warnings: 0,
        },
        ready: startupReady,
        blockers: startupReady ? [] : [status.detail || 'Resolve Tailscale provider checks before starting tunnels.'],
      }));
      return { providerChecks, modes: modeChecks };
    },
    start: async (request, context = {}) => {
      if (request.mode !== TUNNEL_MODE_PRIVATE_NETWORK && request.mode !== TUNNEL_MODE_QUICK) {
        throw new TunnelServiceError(
          'mode_unsupported',
          `Tailscale only supports '${TUNNEL_MODE_PRIVATE_NETWORK}' and '${TUNNEL_MODE_QUICK}' modes`,
        );
      }
      return startTailscaleTunnel({
        mode: request.mode,
        port: context.activePort,
        tailscaleHttpsPort: request.tailscaleHttpsPort,
      });
    },
    stop: (controller) => {
      controller?.stop?.();
    },
    resolvePublicUrl: (controller) => controller?.getPublicUrl?.() ?? null,
    getMetadata: () => null,
  };
}
