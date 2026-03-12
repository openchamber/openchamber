import {
  checkCloudflareApiReachability,
  checkCloudflaredAvailable,
  inspectManagedLocalCloudflareConfig,
  normalizeCloudflareTunnelHostname,
  startCloudflareManagedLocalTunnel,
  startCloudflareManagedRemoteTunnel,
  startCloudflareQuickTunnel,
} from '../../cloudflare-tunnel.js';

import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
} from '../types.js';

export const cloudflareTunnelProviderCapabilities = {
  provider: TUNNEL_PROVIDER_CLOUDFLARE,
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
      stability: 'ga',
    },
    {
      key: TUNNEL_MODE_MANAGED_REMOTE,
      label: 'Managed Remote Tunnel',
      intent: TUNNEL_INTENT_PERSISTENT_PUBLIC,
      requires: ['token', 'hostname'],
      supports: ['customDomain', 'sessionTTL'],
      stability: 'ga',
    },
    {
      key: TUNNEL_MODE_MANAGED_LOCAL,
      label: 'Managed Local Tunnel',
      intent: TUNNEL_INTENT_PERSISTENT_PUBLIC,
      requires: [],
      supports: ['configFile', 'customDomain', 'sessionTTL'],
      stability: 'ga',
    },
  ],
};

export function createCloudflareTunnelProvider() {
  const validateTokenShape = (value) => {
    if (typeof value !== 'string') {
      return { ok: false, detail: 'Managed remote token is missing.' };
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return { ok: false, detail: 'Managed remote token is missing.' };
    }
    if (/\s/.test(trimmed)) {
      return { ok: false, detail: 'Managed remote token has whitespace; provide the raw token value.' };
    }
    return { ok: true, detail: 'Managed remote token looks valid.' };
  };

  const createModeSummary = (checks) => {
    const failures = checks.filter((entry) => entry.status === 'fail').length;
    const warnings = checks.filter((entry) => entry.status === 'warn').length;
    return {
      ready: failures === 0,
      failures,
      warnings,
    };
  };

  const describeMode = ({ mode, checks }) => {
    const summary = createModeSummary(checks);
    const blockers = checks
      .filter((entry) => entry.status === 'fail' && entry.id !== 'startup_readiness')
      .map((entry) => entry.detail || entry.label || entry.id);
    return {
      mode,
      checks,
      summary,
      ready: summary.ready,
      blockers,
    };
  };

  return {
    id: TUNNEL_PROVIDER_CLOUDFLARE,
    capabilities: cloudflareTunnelProviderCapabilities,
    checkAvailability: async () => {
      const result = await checkCloudflaredAvailable();
      if (result.available) {
        return result;
      }
      return {
        ...result,
        message: 'cloudflared is not installed. Install it with: brew install cloudflared',
      };
    },
    diagnose: async (request = {}) => {
      const dependency = await checkCloudflaredAvailable();
      const network = await checkCloudflareApiReachability();

      const providerChecks = [
        {
          id: 'dependency',
          label: 'cloudflared installed',
          status: dependency.available ? 'pass' : 'fail',
          detail: dependency.available
            ? (dependency.version || dependency.path || 'cloudflared available')
            : 'cloudflared is not installed. Install it with: brew install cloudflared',
        },
        {
          id: 'network',
          label: 'Cloudflare API reachable',
          status: network.reachable ? 'pass' : 'fail',
          detail: network.reachable
            ? (network.status ? `HTTP ${network.status}` : 'Reachable')
            : (network.error || 'Could not reach api.trycloudflare.com'),
        },
      ];

      const startupReady = dependency.available && network.reachable;
      const startupDetail = startupReady
        ? 'Provider dependency and network checks passed.'
        : 'Resolve provider checks before starting tunnels.';

      const quickChecks = [
        {
          id: 'startup_readiness',
          label: 'Provider startup readiness',
          status: startupReady ? 'pass' : 'fail',
          detail: startupDetail,
        },
        {
          id: 'quick_mode_prerequisites',
          label: 'Quick tunnel prerequisites',
          status: network.reachable ? 'pass' : 'fail',
          detail: network.reachable
            ? 'Cloudflare edge is reachable for quick tunnels.'
            : 'Cloudflare edge is not reachable for quick tunnels.',
        },
      ];

      const managedLocalInspection = inspectManagedLocalCloudflareConfig({
        configPath: request.configPath,
        hostname: request.hostname,
      });
      const managedLocalChecks = [
        {
          id: 'startup_readiness',
          label: 'Provider startup readiness',
          status: startupReady ? 'pass' : 'fail',
          detail: startupDetail,
        },
        {
          id: 'managed_local_config',
          label: 'Managed local config',
          status: managedLocalInspection.ok ? 'pass' : 'fail',
          detail: managedLocalInspection.ok
            ? `${managedLocalInspection.effectiveConfigPath}${managedLocalInspection.resolvedHostname ? ` (${managedLocalInspection.resolvedHostname})` : ''}`
            : managedLocalInspection.error,
        },
      ];

      const normalizedHost = normalizeCloudflareTunnelHostname(request.hostname);
      const hostnameMissing = !normalizedHost;
      const remoteTokenValidation = validateTokenShape(request.token);
      const tokenMissing = typeof request.token !== 'string' || request.token.trim().length === 0;
      const hasSavedManagedRemoteProfile = request.hasSavedManagedRemoteProfile === true;
      const savedProfileReadyDetail = 'Ready (at least one saved profile present).';
      const managedRemoteChecks = [
        {
          id: 'startup_readiness',
          label: 'Provider startup readiness',
          status: startupReady ? 'pass' : 'fail',
          detail: startupDetail,
        },
        {
          id: 'managed_remote_hostname',
          label: 'Managed remote hostname',
          status: normalizedHost || (hostnameMissing && hasSavedManagedRemoteProfile) ? 'pass' : 'fail',
          detail: normalizedHost
            ? normalizedHost
            : (hostnameMissing && hasSavedManagedRemoteProfile)
              ? savedProfileReadyDetail
              : 'Managed remote hostname is required (use --hostname).',
        },
        {
          id: 'managed_remote_token',
          label: 'Managed remote token',
          status: remoteTokenValidation.ok || (tokenMissing && hasSavedManagedRemoteProfile) ? 'pass' : 'fail',
          detail: (tokenMissing && hasSavedManagedRemoteProfile)
            ? savedProfileReadyDetail
            : remoteTokenValidation.detail,
        },
      ];

      const allModes = [
        describeMode({ mode: TUNNEL_MODE_QUICK, checks: quickChecks }),
        describeMode({ mode: TUNNEL_MODE_MANAGED_REMOTE, checks: managedRemoteChecks }),
        describeMode({ mode: TUNNEL_MODE_MANAGED_LOCAL, checks: managedLocalChecks }),
      ];

      const modeFilter = typeof request.mode === 'string' && request.mode.trim().length > 0
        ? request.mode.trim().toLowerCase()
        : null;
      const modes = modeFilter ? allModes.filter((entry) => entry.mode === modeFilter) : allModes;

      return {
        providerChecks,
        modes,
      };
    },
    start: async (request, context = {}) => {
      if (request.mode === TUNNEL_MODE_MANAGED_REMOTE) {
        return startCloudflareManagedRemoteTunnel({
          token: request.token,
          hostname: request.hostname,
        });
      }

      if (request.mode === TUNNEL_MODE_MANAGED_LOCAL) {
        return startCloudflareManagedLocalTunnel({
          configPath: request.configPath,
          hostname: request.hostname,
        });
      }

      if (!context.originUrl) {
        throw new TunnelServiceError('validation_error', 'originUrl is required for quick tunnel mode');
      }

      return startCloudflareQuickTunnel({
        originUrl: context.originUrl,
        port: context.activePort,
      });
    },
    stop: (controller) => {
      controller?.stop?.();
    },
    resolvePublicUrl: (controller) => controller?.getPublicUrl?.() ?? null,
    getMetadata: (controller) => ({
      configPath: controller?.getEffectiveConfigPath?.() ?? null,
      resolvedHostname: controller?.getResolvedHostname?.() ?? null,
    }),
  };
}
