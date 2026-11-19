import { isEnterpriseMode } from '../enterprise-mode.js';
import type { Application, RequestHandler } from '../shared/http-contracts.js';
import type { SettingsDocument } from '../settings/settings-helpers.js';
import type { TunnelController, TunnelDoctorCheck, TunnelDoctorRequest } from './contracts.js';
import type { createTunnelService } from './index.js';
import type { createTunnelProviderRegistry } from './registry.js';
import type { createTunnelAuth } from './tunnel-auth.js';
import type { createManagedTunnelConfigRuntime } from './managed-config.js';
import type { createSettingsNormalizationRuntime } from '../settings/settings-normalization-runtime.js';
import type * as tunnelTypes from './types.js';

type ManagedConfigRuntime = ReturnType<typeof createManagedTunnelConfigRuntime>;
type SettingsNormalizationRuntime = ReturnType<typeof createSettingsNormalizationRuntime>;
type RouteDoctorRequest = TunnelDoctorRequest & Record<string, TunnelDoctorRequest[keyof TunnelDoctorRequest]>;

export interface TunnelRoutesDependencies {
  crypto: Pick<typeof import('node:crypto'), 'randomUUID'>;
  URL: typeof URL;
  tunnelService: ReturnType<typeof createTunnelService>;
  tunnelProviderRegistry: ReturnType<typeof createTunnelProviderRegistry>;
  tunnelAuthController: ReturnType<typeof createTunnelAuth>;
  hasUiPassword: boolean;
  readSettingsFromDiskMigrated: () => Promise<SettingsDocument>;
  readManagedRemoteTunnelConfigFromDisk: ManagedConfigRuntime['readManagedRemoteTunnelConfigFromDisk'];
  normalizeTunnelProvider: typeof tunnelTypes.normalizeTunnelProvider;
  normalizeTunnelMode: typeof tunnelTypes.normalizeTunnelMode;
  normalizeOptionalPath: typeof tunnelTypes.normalizeOptionalPath;
  normalizeManagedRemoteTunnelHostname: SettingsNormalizationRuntime['normalizeManagedRemoteTunnelHostname'];
  normalizeTunnelBootstrapTtlMs: (value: SettingsDocument[string]) => number | null;
  normalizeTunnelSessionTtlMs: (value: SettingsDocument[string]) => number;
  isSupportedTunnelMode: typeof tunnelTypes.isSupportedTunnelMode;
  upsertManagedRemoteTunnelToken: ManagedConfigRuntime['upsertManagedRemoteTunnelToken'];
  resolveManagedRemoteTunnelToken: ManagedConfigRuntime['resolveManagedRemoteTunnelToken'];
  TUNNEL_MODE_MANAGED_REMOTE: typeof tunnelTypes.TUNNEL_MODE_MANAGED_REMOTE;
  TUNNEL_PROVIDER_CLOUDFLARE: typeof tunnelTypes.TUNNEL_PROVIDER_CLOUDFLARE;
  TunnelServiceError: typeof tunnelTypes.TunnelServiceError;
  getActivePort: () => number;
  getRuntimeManagedRemoteTunnelHostname: () => string | undefined;
  setRuntimeManagedRemoteTunnelHostname: (value: string | undefined) => void;
  getRuntimeManagedRemoteTunnelToken: () => string;
  setRuntimeManagedRemoteTunnelToken: (value: string) => void;
  getActiveTunnelController: () => TunnelController | null;
  setActiveTunnelController: (value: TunnelController | null) => void;
}

export interface NormalizedTunnelRouteRequest {
  provider: string;
  mode: string;
  intent?: string | undefined;
  hostname?: string | undefined;
  token: string;
  configPath?: string | null | undefined;
  httpsPort?: unknown;
  selectedPresetId?: string;
  selectedPresetName?: string;
}

interface TunnelRouteBody {
  provider?: unknown;
  mode?: unknown;
  intent?: unknown;
  presetId?: unknown;
  presetName?: unknown;
  managedRemoteTunnelPresetId?: unknown;
  managedRemoteTunnelPresetName?: unknown;
  configPath?: unknown;
  managedRemoteTunnelHostname?: unknown;
  tunnelHostname?: unknown;
  hostname?: unknown;
  managedRemoteTunnelToken?: unknown;
  tunnelToken?: unknown;
  token?: unknown;
  managedRemoteTunnelTokenProvided?: unknown;
  tunnelTokenProvided?: unknown;
  tokenProvided?: unknown;
  managedRemoteTunnelHostnameProvided?: unknown;
  tunnelHostnameProvided?: unknown;
  hostnameProvided?: unknown;
  connectTtlMs?: unknown;
  sessionTtlMs?: unknown;
  httpsPort?: unknown;
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';

const TUNNEL_BLOCKED_ERROR = 'External tunnels are not available in enterprise mode. Pair devices on your network or through your own relay instead.';

export const createTunnelRoutesRuntime = (dependencies: TunnelRoutesDependencies) => {
  const {
    crypto,
    URL,
    tunnelService,
    tunnelProviderRegistry,
    tunnelAuthController,
    hasUiPassword,
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
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TunnelServiceError,
    getActivePort,
    getRuntimeManagedRemoteTunnelHostname,
    setRuntimeManagedRemoteTunnelHostname,
    getRuntimeManagedRemoteTunnelToken,
    setRuntimeManagedRemoteTunnelToken,
    getActiveTunnelController,
    setActiveTunnelController,
  } = dependencies;

  const resolveActiveNormalizedTunnelMode = () => normalizeTunnelMode(tunnelService.resolveActiveMode());

  const resolveNormalizedTunnelHost = (publicUrl: string) => {
    if (publicUrl.trim().length === 0) {
      return null;
    }
    try {
      return new URL(publicUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  };

  const resolvePreferredTunnelProvider = async (reqBody: TunnelRouteBody | null = null) => {
    if (isText(reqBody?.provider) && reqBody.provider.trim().length > 0) {
      return normalizeTunnelProvider(reqBody.provider);
    }
    const activeProvider = tunnelService.resolveActiveProvider();
    if (activeProvider) {
      return normalizeTunnelProvider(activeProvider);
    }
    const settings = await readSettingsFromDiskMigrated();
    return normalizeTunnelProvider(isText(settings?.tunnelProvider) ? settings.tunnelProvider : undefined);
  };

  const startTunnelWithNormalizedRequest = async ({
    provider,
    mode,
    intent,
    hostname,
    token,
    configPath,
    httpsPort,
    selectedPresetId,
    selectedPresetName,
  }: NormalizedTunnelRouteRequest) => {
    if (isEnterpriseMode()) {
      throw Object.assign(new Error(TUNNEL_BLOCKED_ERROR), { code: 'enterprise_mode' });
    }
    if (!hasUiPassword) {
      throw new Error('A UI password is required before starting a public tunnel. Restart OpenChamber with --ui-password.');
    }
    if (provider === TUNNEL_PROVIDER_CLOUDFLARE && mode === TUNNEL_MODE_MANAGED_REMOTE) {
      setRuntimeManagedRemoteTunnelHostname(hostname);
      setRuntimeManagedRemoteTunnelToken(token);

      if (token && hostname) {
        await upsertManagedRemoteTunnelToken({
          id: selectedPresetId || hostname,
          name: selectedPresetName || hostname,
          hostname,
          token,
        });
      }
    }

    const result = await tunnelService.start({
      provider,
      mode,
      intent,
      configPath,
      token,
      hostname,
      httpsPort,
    });

    console.log(`Tunnel active (${result.provider}): ${result.publicUrl}`);
    return {
      publicUrl: result.publicUrl,
      mode: result.activeMode,
      provider: result.provider,
      providerMetadata: result.providerMetadata,
    };
  };

  const createGenericModeChecks = ({ modeKey, requiredFields, doctorRequest, startupReady }: {
    modeKey: string;
    requiredFields: string[];
    doctorRequest: RouteDoctorRequest;
    startupReady: boolean;
  }) => {
    const checks: TunnelDoctorCheck[] = [
      {
        id: 'startup_readiness',
        label: 'Provider startup readiness',
        status: startupReady ? 'pass' : 'fail',
        detail: startupReady
          ? 'Provider dependency checks passed.'
          : 'Resolve provider checks before starting tunnels.',
      },
    ];

    for (const field of requiredFields) {
      const value = doctorRequest?.[field];
      const present = isText(value) ? value.trim().length > 0 : Boolean(value);
      checks.push({
        id: `requirement_${field}`,
        label: `Required: ${field}`,
        status: present ? 'pass' : 'fail',
        detail: present
          ? `${field} is configured.`
          : `${field} is required for ${modeKey}.`,
      });
    }

    const failures = checks.filter((entry) => entry.status === 'fail').length;
    const warnings = checks.filter((entry) => entry.status === 'warn').length;
    return {
      mode: modeKey,
      checks,
      summary: {
        ready: failures === 0,
        failures,
        warnings,
      },
      ready: failures === 0,
      blockers: checks
        .filter((entry) => entry.status === 'fail' && entry.id !== 'startup_readiness')
        .map((entry) => entry.detail || entry.label || entry.id),
    };
  };

  const runTunnelDoctor = async ({ providerId, modeFilter, doctorRequest }: {
    providerId: string;
    modeFilter: string | null;
    doctorRequest: RouteDoctorRequest;
  }) => {
    const provider = tunnelProviderRegistry.get(providerId);
    if (!provider) {
      throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${providerId}`);
    }

    const capabilities = provider.capabilities || {};
    const modeKeys = Array.isArray(capabilities.modes)
      ? capabilities.modes.map((entry) => entry?.key).filter((key) => key.length > 0)
      : [];

    if (modeFilter && !modeKeys.includes(modeFilter)) {
      throw new TunnelServiceError('mode_unsupported', `Provider '${providerId}' does not support mode '${modeFilter}'`);
    }

    if (provider.diagnose) {
      const diagnosed = await provider.diagnose({
        ...doctorRequest,
        mode: modeFilter || doctorRequest?.mode,
      }, {
        capabilities,
      });
      const providerChecks = Array.isArray(diagnosed?.providerChecks) ? diagnosed.providerChecks : [];
      const allModes = Array.isArray(diagnosed?.modes) ? diagnosed.modes : [];
      const modes = modeFilter ? allModes.filter((entry) => entry?.mode === modeFilter) : allModes;
      return {
        ok: true,
        provider: providerId,
        providerChecks,
        modes,
      };
    }

    const availability = await tunnelService.checkAvailability(providerId);
    const dependencyAvailable = Boolean(availability?.available);
    const providerChecks = [{
      id: 'dependency',
      label: 'Provider dependency',
      status: dependencyAvailable ? 'pass' : 'fail',
      detail: dependencyAvailable
        ? (availability?.version || 'available')
        : (availability?.message || 'Required provider dependency is unavailable.'),
    }];

    const targetModes = (Array.isArray(capabilities.modes) ? capabilities.modes : [])
      .filter((entry) => !modeFilter || entry?.key === modeFilter);
    const modes = targetModes.map((entry) => createGenericModeChecks({
      modeKey: entry.key,
      requiredFields: Array.isArray(entry?.requires) ? entry.requires : [],
      doctorRequest,
      startupReady: dependencyAvailable,
    }));

    return {
      ok: true,
      provider: providerId,
      providerChecks,
      modes,
    };
  };

  const registerRoutes = (app: Application) => {
    app.get('/api/openchamber/tunnel/check', async (req, res) => {
      try {
        const requestedProvider = isText(req?.query?.provider) && req.query.provider.trim().length > 0
          ? normalizeTunnelProvider(req.query.provider)
          : await resolvePreferredTunnelProvider();
        const result = await tunnelService.checkAvailability(requestedProvider);
        res.json({
          available: result.available,
          provider: requestedProvider,
          version: result.version || null,
          dependency: result.dependency || null,
          installCommand: result.installCommand || null,
          installUrl: result.installUrl || null,
          platform: result.platform || process.platform,
          message: result.message || null,
        });
      } catch (error) {
        console.warn('Tunnel dependency check failed:', error);
        res.json({ available: false, provider: null, version: null, dependency: null, installCommand: null, installUrl: null, platform: process.platform, message: null });
      }
    });

    const handleTunnelDoctor: RequestHandler<TunnelRouteBody> = async (req, res) => {
      try {
        const params = req.query || {};
        const body = req.body || {};

        const providerId = isText(params.provider) && params.provider.trim().length > 0
          ? normalizeTunnelProvider(params.provider)
          : await resolvePreferredTunnelProvider();
        const modeFilter = isText(params.mode) && params.mode.trim().length > 0
          ? params.mode.trim().toLowerCase()
          : null;

        const settings = await readSettingsFromDiskMigrated();
        const selectedPresetId = isText(params.managedRemoteTunnelPresetId)
          ? params.managedRemoteTunnelPresetId.trim()
          : '';
        const requestConfigPath = normalizeOptionalPath(isText(params.configPath) || params.configPath === null ? params.configPath : undefined)
          ?? normalizeOptionalPath(isText(settings?.managedLocalTunnelConfigPath) || settings?.managedLocalTunnelConfigPath === null ? settings.managedLocalTunnelConfigPath : undefined);
        const requestManagedRemoteHostname = normalizeManagedRemoteTunnelHostname(params.managedRemoteTunnelHostname);
        const requestTunnelHostname = normalizeManagedRemoteTunnelHostname(params.tunnelHostname);
        const requestHostname = normalizeManagedRemoteTunnelHostname(params.hostname);
        const hostnameFromSettings = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        const hostname = requestHostname || requestTunnelHostname || requestManagedRemoteHostname || hostnameFromSettings;

        const requestManagedRemoteToken = isText(body.managedRemoteTunnelToken)
          ? body.managedRemoteTunnelToken.trim()
          : '';
        const requestTunnelToken = isText(body.tunnelToken)
          ? body.tunnelToken.trim()
          : '';
        const requestToken = isText(body.token)
          ? body.token.trim()
          : '';
        const requestTokenProvided = body.managedRemoteTunnelTokenProvided === true
          || body.tunnelTokenProvided === true
          || body.tokenProvided === true;
        const requestHostnameProvided = body.managedRemoteTunnelHostnameProvided === true
          || body.tunnelHostnameProvided === true
          || body.hostnameProvided === true;
        const storedManagedRemoteToken = isText(settings?.managedRemoteTunnelToken)
          ? settings.managedRemoteTunnelToken.trim()
          : '';
        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        const serverHasSavedManagedRemoteProfile = managedRemoteTunnelConfig.tunnels.some((entry) => {
          const savedHostname = normalizeManagedRemoteTunnelHostname(entry?.hostname);
          const savedToken = entry.token.trim();
          return Boolean(savedHostname && savedToken);
        });
        const cliHasSavedManagedRemoteProfile = params.hasSavedManagedRemoteProfile === '1';
        const hasSavedManagedRemoteProfile = serverHasSavedManagedRemoteProfile || cliHasSavedManagedRemoteProfile;
        const configManagedRemoteToken = providerId === TUNNEL_PROVIDER_CLOUDFLARE
          ? await resolveManagedRemoteTunnelToken({ presetId: selectedPresetId, hostname })
          : '';
        const runtimeHostname = getRuntimeManagedRemoteTunnelHostname();
        const runtimeToken = getRuntimeManagedRemoteTunnelToken();
        const token = requestToken
          || requestTunnelToken
          || requestManagedRemoteToken
          || ((runtimeHostname && hostname && runtimeHostname === hostname) ? runtimeToken : '')
          || configManagedRemoteToken
          || storedManagedRemoteToken;

        const doctorRequest = {
          mode: modeFilter,
          hostname,
          token,
          tokenProvided: requestTokenProvided,
          hostnameProvided: requestHostnameProvided,
          configPath: requestConfigPath,
          hasSavedManagedRemoteProfile,
        };

        const result = await runTunnelDoctor({
          providerId,
          modeFilter,
          doctorRequest,
        });
        return res.json(result);
      } catch (error) {
        if (error instanceof TunnelServiceError) {
          return res.status(400).json({ ok: false, error: error.message, code: error.code });
        }
        console.warn('Tunnel doctor failed:', error);
        return res.status(500).json({ ok: false, error: 'Failed to run tunnel doctor' });
      }
    };
    app.post('/api/openchamber/tunnel/doctor', handleTunnelDoctor);
    app.get('/api/openchamber/tunnel/doctor', handleTunnelDoctor);

    app.get('/api/openchamber/tunnel/providers', (_req, res) => {
      const providers = tunnelProviderRegistry.listCapabilities();
      return res.json({ providers });
    });

    app.get('/api/openchamber/tunnel/status', async (_req, res) => {
      try {
        const settings = await readSettingsFromDiskMigrated();
        const normalizedMode = normalizeTunnelMode(isText(settings?.tunnelMode) ? settings.tunnelMode : undefined);
        const managedRemoteHostname = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        const managedRemoteTunnelPresetSummaries = managedRemoteTunnelConfig.tunnels.map((entry) => ({
          id: entry.id,
          name: entry.name,
          hostname: entry.hostname,
        }));
        const hasStoredManagedRemoteToken = isText(settings?.managedRemoteTunnelToken) && settings.managedRemoteTunnelToken.trim().length > 0;
        const hasManagedRemoteTunnelToken = getRuntimeManagedRemoteTunnelToken().length > 0 || managedRemoteTunnelConfig.tunnels.length > 0 || hasStoredManagedRemoteToken;
        const bootstrapTtlMs = settings?.tunnelBootstrapTtlMs === null
          ? null
          : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs);
        const sessionTtlMs = normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);
        const activeSessions = tunnelAuthController.listTunnelSessions();
        const activeProvider = tunnelService.resolveActiveProvider();
        const provider = activeProvider || normalizeTunnelProvider(isText(settings?.tunnelProvider) ? settings.tunnelProvider : undefined);

        const publicUrl = tunnelService.getPublicUrl();
        if (!publicUrl) {
          return res.json({
            active: false,
            enterpriseMode: isEnterpriseMode(),
            url: null,
            mode: normalizedMode,
            provider,
            providerMetadata: null,
            hasManagedRemoteTunnelToken,
            managedRemoteTunnelHostname: managedRemoteHostname || null,
            managedRemoteTunnelPresets: managedRemoteTunnelPresetSummaries,
            managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id),
            hasBootstrapToken: false,
            bootstrapExpiresAt: null,
            policy: 'tunnel-gated',
            activeTunnelMode: tunnelAuthController.getActiveTunnelMode() || null,
            activeSessions,
            localPort: getActivePort(),
            ttlConfig: {
              bootstrapTtlMs,
              sessionTtlMs,
            },
          });
        }

        const activeNormalizedMode = resolveActiveNormalizedTunnelMode();
        const activeTunnelId = tunnelAuthController.getActiveTunnelId();
        const activeTunnelHost = tunnelAuthController.getActiveTunnelHost();
        const resolvedTunnelHost = resolveNormalizedTunnelHost(publicUrl);
        const activeTunnelMode = tunnelAuthController.getActiveTunnelMode();
        const needsActiveTunnelSync = !activeTunnelId
          || !activeTunnelHost
          || !resolvedTunnelHost
          || activeTunnelHost !== resolvedTunnelHost
          || activeTunnelMode !== activeNormalizedMode;
        if (needsActiveTunnelSync) {
          tunnelAuthController.setActiveTunnel({
            tunnelId: activeTunnelId || crypto.randomUUID(),
            publicUrl,
            mode: activeNormalizedMode,
          });
        }

        const bootstrapStatus = tunnelAuthController.getBootstrapStatus();
        const providerMetadata = tunnelService.getProviderMetadata();

        return res.json({
          active: true,
          url: publicUrl,
          mode: activeNormalizedMode,
          provider,
          providerMetadata,
          hasManagedRemoteTunnelToken,
          managedRemoteTunnelHostname: managedRemoteHostname || null,
          managedRemoteTunnelPresets: managedRemoteTunnelPresetSummaries,
          managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id),
          hasBootstrapToken: bootstrapStatus.hasBootstrapToken,
          bootstrapExpiresAt: bootstrapStatus.bootstrapExpiresAt,
          policy: 'tunnel-gated',
          activeTunnelMode: activeNormalizedMode,
          activeSessions: tunnelAuthController.listTunnelSessions(),
          localPort: getActivePort(),
          ttlConfig: {
            bootstrapTtlMs,
            sessionTtlMs,
          },
        });
      } catch {
        return res.status(500).json({ error: 'Failed to get tunnel status' });
      }
    });

    app.put<TunnelRouteBody>('/api/openchamber/tunnel/managed-remote-token', async (req, res) => {
      try {
        const presetId = isText(req?.body?.presetId) ? req.body.presetId.trim() : '';
        const presetName = isText(req?.body?.presetName) ? req.body.presetName.trim() : '';
        const managedRemoteTunnelHostname = normalizeManagedRemoteTunnelHostname(req?.body?.managedRemoteTunnelHostname);
        const managedRemoteTunnelToken = isText(req?.body?.managedRemoteTunnelToken) ? req.body.managedRemoteTunnelToken.trim() : '';

        if (!presetId || !presetName || !managedRemoteTunnelHostname || !managedRemoteTunnelToken) {
          return res.status(400).json({ ok: false, error: 'presetId, presetName, managedRemoteTunnelHostname and managedRemoteTunnelToken are required' });
        }

        await upsertManagedRemoteTunnelToken({
          id: presetId,
          name: presetName,
          hostname: managedRemoteTunnelHostname,
          token: managedRemoteTunnelToken,
        });

        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        return res.json({ ok: true, managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id) });
      } catch {
        return res.status(500).json({ ok: false, error: 'Failed to save managed remote tunnel token' });
      }
    });

    app.post<TunnelRouteBody>('/api/openchamber/tunnel/start', async (_req, res) => {
      if (isEnterpriseMode()) {
        return res.status(403).json({ ok: false, code: 'enterprise_mode', error: TUNNEL_BLOCKED_ERROR });
      }
      if (!hasUiPassword) {
        return res.status(403).json({ ok: false, code: 'ui_password_required', error: 'A UI password is required before starting a public tunnel. Restart OpenChamber with --ui-password.' });
      }
      try {
        const settings = await readSettingsFromDiskMigrated();
        if (isText(_req?.body?.provider) && _req.body.provider.trim().length > 0) {
          const rawProvider = _req.body.provider.trim().toLowerCase();
          if (!tunnelProviderRegistry.get(rawProvider)) {
            return res.status(422).json({ ok: false, error: `Unsupported tunnel provider: ${rawProvider}`, code: 'provider_unsupported' });
          }
        }
        const providerInput = _req?.body?.provider ?? settings?.tunnelProvider;
        const provider = normalizeTunnelProvider(isText(providerInput) ? providerInput : undefined);
        const modeInput = _req?.body?.mode ?? settings?.tunnelMode;
        const intent = isText(_req?.body?.intent) ? _req.body.intent.trim().toLowerCase() : undefined;
        const mode = isText(modeInput)
          ? modeInput.trim().toLowerCase()
          : normalizeTunnelMode(undefined);
        if (isText(_req?.body?.mode) && _req.body.mode.trim().length > 0 && !isSupportedTunnelMode(mode)) {
          return res.status(422).json({ ok: false, error: `Unsupported tunnel mode: ${mode}`, code: 'mode_unsupported' });
        }
        const selectedPresetId = isText(_req?.body?.managedRemoteTunnelPresetId) ? _req.body.managedRemoteTunnelPresetId.trim() : '';
        const selectedPresetName = isText(_req?.body?.managedRemoteTunnelPresetName) ? _req.body.managedRemoteTunnelPresetName.trim() : '';
        const requestConfigPath = normalizeOptionalPath(isText(_req?.body?.configPath) || _req?.body?.configPath === null ? _req.body.configPath : undefined)
          ?? normalizeOptionalPath(isText(settings?.managedLocalTunnelConfigPath) || settings?.managedLocalTunnelConfigPath === null ? settings.managedLocalTunnelConfigPath : undefined);
        const requestManagedRemoteHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.managedRemoteTunnelHostname);
        const requestTunnelHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.tunnelHostname);
        const requestHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.hostname);
        const hostnameFromSettings = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        const hostname = requestHostname || requestTunnelHostname || requestManagedRemoteHostname || hostnameFromSettings;
        const requestManagedRemoteToken = isText(_req?.body?.managedRemoteTunnelToken) ? _req.body.managedRemoteTunnelToken.trim() : '';
        const requestTunnelToken = isText(_req?.body?.tunnelToken) ? _req.body.tunnelToken.trim() : '';
        const requestToken = isText(_req?.body?.token) ? _req.body.token.trim() : '';
        const storedManagedRemoteToken = isText(settings?.managedRemoteTunnelToken) ? settings.managedRemoteTunnelToken.trim() : '';
        const configManagedRemoteToken = provider === TUNNEL_PROVIDER_CLOUDFLARE
          ? await resolveManagedRemoteTunnelToken({ presetId: selectedPresetId, hostname })
          : '';
        const runtimeHostname = getRuntimeManagedRemoteTunnelHostname();
        const runtimeToken = getRuntimeManagedRemoteTunnelToken();
        const token = requestToken
          || requestTunnelToken
          || requestManagedRemoteToken
          || ((runtimeHostname && hostname && runtimeHostname === hostname) ? runtimeToken : '')
          || configManagedRemoteToken
          || storedManagedRemoteToken;
        const requestConnectTtlMs = isNumber(_req?.body?.connectTtlMs) && Number.isFinite(_req.body.connectTtlMs)
          ? normalizeTunnelBootstrapTtlMs(_req.body.connectTtlMs)
          : undefined;
        const requestSessionTtlMs = isNumber(_req?.body?.sessionTtlMs) && Number.isFinite(_req.body.sessionTtlMs)
          ? normalizeTunnelSessionTtlMs(_req.body.sessionTtlMs)
          : undefined;
        const bootstrapTtlMs = requestConnectTtlMs ?? (settings?.tunnelBootstrapTtlMs === null
          ? null
          : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs));
        const sessionTtlMs = requestSessionTtlMs ?? normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);
        const allowedHttpsPorts = tunnelProviderRegistry.get(provider)?.capabilities?.modes
          ?.find((entry) => entry.key === mode)?.httpsPorts ?? [];
        const savedHttpsPort = isNumber(settings?.tunnelHttpsPort) && allowedHttpsPorts.includes(settings.tunnelHttpsPort) ? settings.tunnelHttpsPort : undefined;
        const httpsPort = _req?.body?.httpsPort ?? savedHttpsPort;

        const previousTunnelId = tunnelAuthController.getActiveTunnelId();
        const previousMode = tunnelAuthController.getActiveTunnelMode();
        const previousProvider = tunnelService.resolveActiveProvider();
        const previousUrl = tunnelService.getPublicUrl();

        const { publicUrl, provider: activeProvider, providerMetadata } = await startTunnelWithNormalizedRequest({
          provider,
          mode,
          intent,
          hostname,
          token,
          configPath: requestConfigPath,
          httpsPort,
          selectedPresetId,
          selectedPresetName,
        });

        const replacedTunnel = Boolean(previousTunnelId) && (
          previousMode !== mode
          || previousProvider !== activeProvider
          || previousUrl !== publicUrl
        );
        let revokedBootstrapCount = 0;
        let invalidatedSessionCount = 0;
        if (replacedTunnel && previousTunnelId) {
          const revoked = tunnelAuthController.revokeTunnelArtifacts(previousTunnelId);
          revokedBootstrapCount = revoked.revokedBootstrapCount;
          invalidatedSessionCount = revoked.invalidatedSessionCount;
        }

        tunnelAuthController.setActiveTunnel({
          tunnelId: replacedTunnel || !previousTunnelId ? crypto.randomUUID() : previousTunnelId,
          publicUrl,
          mode,
        });

        const bootstrapToken = tunnelAuthController.issueBootstrapToken({ ttlMs: bootstrapTtlMs });
        const connectUrl = `${publicUrl.replace(/\/$/, '')}/connect?t=${encodeURIComponent(bootstrapToken.token)}`;
        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        const isCloudflareProvider = activeProvider === TUNNEL_PROVIDER_CLOUDFLARE;

        return res.json({
          ok: true,
          url: publicUrl,
          mode,
          provider: activeProvider,
          providerMetadata,
          managedRemoteTunnelHostname: isCloudflareProvider ? (hostname || null) : null,
          managedRemoteTunnelTokenPresetIds: isCloudflareProvider ? managedRemoteTunnelConfig.tunnels.map((entry) => entry.id) : [],
          connectUrl,
          bootstrapExpiresAt: bootstrapToken.expiresAt,
          replacedTunnel,
          replaced: replacedTunnel
            ? {
              mode: previousMode,
              provider: previousProvider,
              url: previousUrl,
            }
            : null,
          revokedBootstrapCount,
          invalidatedSessionCount,
          policy: 'tunnel-gated',
          activeTunnelMode: mode,
          activeSessions: tunnelAuthController.listTunnelSessions(),
          localPort: getActivePort(),
          ttlConfig: {
            bootstrapTtlMs,
            sessionTtlMs,
          },
        });
      } catch (error) {
        console.error('Failed to start tunnel:', error);
        setActiveTunnelController(null);
        tunnelAuthController.clearActiveTunnel();
        if (error instanceof TunnelServiceError) {
          const status = error.code === 'missing_dependency'
            ? 400
            : (error.code === 'validation_error' || error.code === 'provider_unsupported' || error.code === 'mode_unsupported'
              ? 422
              : 500);
          return res.status(status).json({
            ok: false,
            error: error.message,
            code: error.code,
            approvalUrl: error.details?.approvalUrl,
          });
        }
        return res.status(500).json({ ok: false, error: 'Failed to start tunnel', code: 'startup_failed' });
      }
    });

    app.post('/api/openchamber/tunnel/stop', (_req, res) => {
      let revokedBootstrapCount = 0;
      let invalidatedSessionCount = 0;
      const activeTunnelId = tunnelAuthController.getActiveTunnelId();

      if (activeTunnelId) {
        const revoked = tunnelAuthController.revokeTunnelArtifacts(activeTunnelId);
        revokedBootstrapCount = revoked.revokedBootstrapCount;
        invalidatedSessionCount = revoked.invalidatedSessionCount;
      }

      if (getActiveTunnelController()) {
        console.log('Stopping active tunnel (user requested)...');
        tunnelService.stop();
      }

      tunnelAuthController.clearActiveTunnel();
      res.json({ ok: true, revokedBootstrapCount, invalidatedSessionCount });
    });
  };

  return {
    registerRoutes,
    startTunnelWithNormalizedRequest,
  };
};
