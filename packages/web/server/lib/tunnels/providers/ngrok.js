import {
  checkNgrokApiReachability,
  checkNgrokAuthtokenConfigured,
  checkNgrokAvailable,
  startNgrokQuickTunnel,
} from '../../ngrok-tunnel.js';

import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_NGROK,
  TunnelServiceError,
} from '../types.js';
import { getTunnelDependencyInstallInfo } from '../install-help.js';

const ngrokTunnelProviderCapabilities = {
  provider: TUNNEL_PROVIDER_NGROK,
  defaults: {
    mode: TUNNEL_MODE_QUICK,
    optionDefaults: {},
  },
  modes: [
    {
      key: TUNNEL_MODE_QUICK,
      label: 'Quick Tunnel',
      intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC,
      requires: [],
      supports: ['sessionTTL'],
      stability: 'beta',
    },
  ],
};

export function createNgrokTunnelProvider() {
  return {
    id: TUNNEL_PROVIDER_NGROK,
    capabilities: ngrokTunnelProviderCapabilities,
    checkAvailability: async () => {
      const result = await checkNgrokAvailable();
      if (result.available) {
        return {
          ...result,
          ...getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_NGROK),
        };
      }
      const installInfo = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_NGROK);
      return {
        ...result,
        ...installInfo,
      };
    },
    diagnose: async () => {
      const dependency = await checkNgrokAvailable();
      const authtoken = await checkNgrokAuthtokenConfigured(dependency.path);
      const network = await checkNgrokApiReachability();
      const installInfo = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_NGROK);
      const startupReady = dependency.available && authtoken.configured && network.reachable;
      const providerChecks = [
        {
          id: 'dependency',
          label: 'ngrok installed',
          status: dependency.available ? 'pass' : 'fail',
          detail: dependency.available
            ? (dependency.version || dependency.path || 'ngrok available')
            : installInfo.message,
        },
        {
          id: 'authtoken',
          label: 'ngrok authtoken configured',
          status: authtoken.configured ? 'pass' : 'fail',
          detail: authtoken.configured
            ? authtoken.detail
            : (authtoken.detail || 'Run: ngrok config add-authtoken <your-ngrok-token>'),
        },
        {
          id: 'network',
          label: 'ngrok API reachable',
          status: network.reachable ? 'pass' : 'fail',
          detail: network.reachable
            ? (network.status ? `HTTP ${network.status}` : 'Reachable')
            : (network.error || 'Could not reach api.ngrok.com'),
        },
      ];

      return {
        providerChecks,
        modes: [
          {
            mode: TUNNEL_MODE_QUICK,
            checks: [
              {
                id: 'startup_readiness',
                label: 'Provider startup readiness',
                status: startupReady ? 'pass' : 'fail',
                detail: startupReady
                  ? 'Provider dependency, auth, and network checks passed.'
                  : 'Resolve provider checks before starting tunnels.',
              },
            ],
            summary: {
              ready: startupReady,
              failures: startupReady ? 0 : 1,
              warnings: 0,
            },
            ready: startupReady,
            blockers: startupReady ? [] : ['Resolve provider checks before starting tunnels.'],
          },
        ],
      };
    },
    start: async (request, context = {}) => {
      if (request.mode !== TUNNEL_MODE_QUICK) {
        throw new TunnelServiceError('mode_unsupported', `Ngrok only supports '${TUNNEL_MODE_QUICK}' mode right now`);
      }
      return startNgrokQuickTunnel({ port: context.activePort });
    },
    stop: (controller) => {
      controller?.stop?.();
    },
    resolvePublicUrl: (controller) => controller?.getPublicUrl?.() ?? null,
    getMetadata: () => null,
  };
}
