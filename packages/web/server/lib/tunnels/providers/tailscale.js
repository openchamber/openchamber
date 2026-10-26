import {
  checkTailscaleAvailable,
  checkTailscaleRunning,
  resolveTailscaleTarget,
  startTailscaleTunnel,
} from '../../tailscale-tunnel.js';
import {
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_INTENT_PRIVATE_NETWORK,
  TUNNEL_MODE_FUNNEL,
  TUNNEL_MODE_SERVE,
  TUNNEL_PROVIDER_TAILSCALE,
  TunnelServiceError,
} from '../types.js';
import { getTunnelDependencyInstallInfo } from '../install-help.js';

// Funnel listens only on these ports (tailscale.com/kb/1223/funnel). Serve
// takes any port, but offering the same three keeps one saved port valid in
// both modes.
const HTTPS_PORTS = [443, 8443, 10000];

export const tailscaleTunnelProviderCapabilities = {
  provider: TUNNEL_PROVIDER_TAILSCALE,
  defaults: {
    mode: TUNNEL_MODE_SERVE,
    optionDefaults: {},
  },
  modes: [
    {
      key: TUNNEL_MODE_SERVE,
      label: 'Serve',
      intent: TUNNEL_INTENT_PRIVATE_NETWORK,
      requires: [],
      supports: ['sessionTTL'],
      httpsPorts: HTTPS_PORTS,
      stability: 'beta',
    },
    {
      key: TUNNEL_MODE_FUNNEL,
      label: 'Funnel',
      intent: TUNNEL_INTENT_PERSISTENT_PUBLIC,
      requires: [],
      supports: ['sessionTTL'],
      httpsPorts: HTTPS_PORTS,
      stability: 'beta',
    },
  ],
};

export function createTailscaleTunnelProvider() {
  return {
    id: TUNNEL_PROVIDER_TAILSCALE,
    capabilities: tailscaleTunnelProviderCapabilities,
    checkAvailability: async () => ({
      ...checkTailscaleAvailable(),
      ...getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_TAILSCALE),
    }),
    diagnose: async () => {
      const target = resolveTailscaleTarget();
      const dependency = checkTailscaleAvailable({ target });
      const installInfo = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_TAILSCALE);
      const running = dependency.available
        ? checkTailscaleRunning({ target })
        : { ready: false, detail: installInfo.message };
      return {
        providerChecks: [
          {
            id: 'dependency',
            label: 'tailscale installed',
            status: dependency.available ? 'pass' : 'fail',
            detail: dependency.available ? (dependency.version || dependency.path) : installInfo.message,
          },
          {
            id: 'running',
            label: 'Tailscale running and signed in',
            status: running.ready ? 'pass' : 'fail',
            detail: running.detail,
          },
        ],
        modes: tailscaleTunnelProviderCapabilities.modes.map((descriptor) => ({
          mode: descriptor.key,
          checks: [
            {
              id: 'startup_readiness',
              label: 'Provider startup readiness',
              status: running.ready ? 'pass' : 'fail',
              detail: running.ready ? 'Tailscale checks passed.' : running.detail,
            },
          ],
          summary: { ready: running.ready, failures: running.ready ? 0 : 1, warnings: 0 },
          ready: running.ready,
          blockers: running.ready ? [] : [running.detail],
        })),
      };
    },
    start: async (request, context = {}) => {
      if (!Number.isInteger(context.activePort)) {
        throw new TunnelServiceError('startup_failed', 'OpenChamber has no local port to share yet');
      }
      const target = resolveTailscaleTarget();
      if (!target) {
        throw new TunnelServiceError('missing_dependency', getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_TAILSCALE).message);
      }
      const running = checkTailscaleRunning({ target });
      if (!running.ready) {
        throw new TunnelServiceError('startup_failed', running.detail);
      }
      return startTailscaleTunnel({
        port: context.activePort,
        mode: request.mode,
        httpsPort: request.httpsPort ?? HTTPS_PORTS[0],
        target,
      });
    },
    stop: (controller) => {
      controller?.stop?.();
    },
    resolvePublicUrl: (controller) => controller?.getPublicUrl?.() ?? null,
    getMetadata: () => null,
  };
}
