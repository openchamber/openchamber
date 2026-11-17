import { readOpenCodeInfo, isSupportedOpenCodeVersion } from './compatibility.js';
import { createSharedHealthProbe, parseHealthWaitMs, waitForOpenCodeHealth } from './health-wait.js';
import express from 'express';
import { resolveNpmRegistryRequest } from './npm-registry-config.js';
import fs from 'fs';
import path from 'path';
import {
  buildAppliedResponse,
} from './config-mutation-response.js';
import { getClaudeCliAuthStatus } from './claude-cli-auth.js';
import { OPENCODE_CONFIG_DIR, readConfigLayers } from './shared.js';
import { settingsSurfaceOf } from './settings-files.js';
import { compactionUpdateSchema, parseWebSearchSelection, readSectionEntry, toProviderEntity } from './config-v2.js';
import { getWebSearchSource, setCompactionSettings, setWarmingEnabled, setWebSearchSelection } from './websearch-config.js';
import {
  CREDENTIAL_LIST_ERROR,
  ENTERPRISE_MODE_ERROR,
  isCredentialListRequest,
  isEnterpriseMode,
  isProviderConnectRequest,
} from '../enterprise-mode.js';
import { discoverProviderModels } from './model-discovery.js';
import { readDisabledProviders, setProviderDisabled } from './providers.js';
import { vcsInitRefusal, vcsInitRefusalBody } from '../git/repository-root.js';

const OPENCODE_INFO_TIMEOUT_MS = 3_000;

export const registerOpenCodeRoutes = (app, dependencies) => {
  const {
    crypto,
    getOpenCodeResolutionSnapshot,
    getOpenCodeUpgradeCapability,
    upgradeOpenCodeCli,
    getOpenCodeCompatibility,
    installOpenCodeV2,
    formatSettingsResponse,
    readSettingsFromDiskMigrated,
    persistSettings,
    resolveProjectDirectory,
    getProviderSources,
    removeProviderConfig,
    upsertProviderConfig,
    refreshOpenCodeAfterConfigChange,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  } = dependencies;

  let authLibrary = null;
  const getAuthLibrary = async () => {
    if (!authLibrary) {
      authLibrary = await import('./auth.js');
    }
    return authLibrary;
  };

  const parseVersionForComparison = (value) => {
    const normalized = String(value || '').replace(/^v/, '').split('+')[0];
    const prereleaseIndex = normalized.indexOf('-');
    const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
    const parts = core.split('.').map((part) => {
      const parsed = Number.parseInt(part || '0', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { parts, prerelease: prereleaseIndex >= 0 };
  };

  const compareVersions = (left, right) => {
    const a = parseVersionForComparison(left);
    const b = parseVersionForComparison(right);
    const length = Math.max(a.parts.length, b.parts.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
      if (diff !== 0) return diff;
    }
    if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
    return 0;
  };

  const fetchLatestOpenCodeVersion = async () => {
    const request = resolveNpmRegistryRequest('@opencode/cli', 'latest');
    const response = await fetch(request.url, {
      headers: { Accept: 'application/json', ...request.headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`OpenCode npm registry responded with ${response.status}`);
    }
    const payload = await response.json();
    const version = typeof payload?.version === 'string' ? payload.version.trim().replace(/^v/, '') : '';
    if (!version) throw new Error('Failed to resolve latest OpenCode version');
    return version;
  };

  app.get('/api/config/settings', async (req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated({ surface: settingsSurfaceOf(req) });
      res.json(formatSettingsResponse(settings));
    } catch (error) {
      console.error('Failed to read settings:', error);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  });

  app.get('/api/config/opencode-resolution', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const resolution = await getOpenCodeResolutionSnapshot(settings);
      res.json(resolution);
    } catch (error) {
      console.error('Failed to resolve OpenCode binary:', error);
      res.status(500).json({ error: 'Failed to resolve OpenCode binary' });
    }
  });

  app.get('/api/opencode/compatibility', async (_req, res) => {
    try { res.json(await getOpenCodeCompatibility()); }
    catch { res.status(503).json({ error: 'Could not check OpenCode compatibility.' }); }
  });

  let installInFlight = null;
  app.post('/api/opencode/install-v2', async (_req, res) => {
    try {
      if (!installInFlight) {
        installInFlight = (async () => {
          const compatibility = await getOpenCodeCompatibility();
          if (!compatibility.canInstall) return false;
          await installOpenCodeV2();
          return true;
        })().finally(() => { installInFlight = null; });
      }
      const installed = await installInFlight;
      if (!installed) return res.status(409).json({ success: false, error: 'Automatic OpenCode v2 installation is unavailable for this runtime.' });
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ success: false, error: 'OpenCode v2 installation or restart failed. Retry or use the installation guide.' });
    }
  });

  let upgradeInFlight = null;
  app.post('/api/opencode/upgrade', async (_req, res) => {
    const capability = getOpenCodeUpgradeCapability();
    if (!capability.supported) {
      const bundled = capability.reason === 'bundled';
      const pinned = capability.reason === 'policy';
      return res.status(409).json({
        success: false,
        code: bundled ? 'OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER' : 'OPENCODE_UPGRADE_UNSUPPORTED',
        error: bundled
          ? 'OpenCode is bundled with OpenChamber Desktop and updates with the app.'
          : pinned
            ? 'Your administrator manages this OpenCode installation.'
            : 'This OpenCode runtime cannot be upgraded by OpenChamber.',
      });
    }
    try {
      if (!upgradeInFlight) {
        upgradeInFlight = upgradeOpenCodeCli().finally(() => { upgradeInFlight = null; });
      }
      await upgradeInFlight;
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/opencode/upgrade-status', async (_req, res) => {
    try {
      const capability = getOpenCodeUpgradeCapability();
      const [healthResponse, latestVersion] = await Promise.all([
        fetch(buildOpenCodeUrl('/api/info', ''), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: AbortSignal.timeout(OPENCODE_INFO_TIMEOUT_MS),
        }),
        fetchLatestOpenCodeVersion(),
      ]);
      const info = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return res.status(healthResponse.status).json({
          available: null,
          error: info?.error || healthResponse.statusText || 'Failed to read OpenCode version',
        });
      }
      const currentVersion = typeof info?.version === 'string' ? info.version.replace(/^v/, '') : null;
      if (!currentVersion || !latestVersion) {
        return res.json({ available: null, currentVersion, latestVersion: latestVersion || null, upgrade: capability });
      }
      const available = capability.reason === 'bundled' || capability.reason === 'policy'
        ? false
        : compareVersions(latestVersion, currentVersion) > 0;
      return res.json({
        available,
        currentVersion,
        latestVersion,
        upgrade: capability,
      });
    } catch (error) {
      return res.status(500).json({
        available: null,
        error: error instanceof Error ? error.message : 'Failed to check OpenCode upgrade status',
      });
    }
  });

  const probeOpenCodeHealth = async () => {
    try {
      const healthResponse = await fetch(buildOpenCodeUrl('/api/info', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(OPENCODE_INFO_TIMEOUT_MS),
      });
      const info = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return {
          healthy: false,
          status: healthResponse.status,
          body: { healthy: false, error: info?.error || healthResponse.statusText || 'OpenCode health check failed' },
        };
      }
      const parsed = await readOpenCodeInfo(Response.json(info));
      const healthy = parsed !== null && isSupportedOpenCodeVersion(parsed.version);
      return { healthy, final: true, status: 200, body: { healthy } };
    } catch (error) {
      return {
        healthy: false,
        status: 503,
        body: { healthy: false, error: error instanceof Error ? error.message : 'OpenCode health check failed' },
      };
    }
  };

  const sharedOpenCodeHealthProbe = createSharedHealthProbe({ probe: probeOpenCodeHealth });

  app.get('/api/opencode/health', async (req, res) => {
    let clientGone = false;
    res.on('close', () => { clientGone = true; });
    const result = await waitForOpenCodeHealth({
      probe: sharedOpenCodeHealthProbe,
      waitMs: parseHealthWaitMs(req.query?.wait),
      isAborted: () => clientGone,
    });
    if (clientGone) return;
    return res.status(result.status).json(result.body);
  });

  app.get('/api/opencode/version', async (_req, res) => {
    try {
      const healthResponse = await fetch(buildOpenCodeUrl('/api/info', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(OPENCODE_INFO_TIMEOUT_MS),
      });
      const info = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return res.status(healthResponse.status).json({
          version: null,
          error: info?.error || healthResponse.statusText || 'Failed to read OpenCode version',
        });
      }
      const version = typeof info?.version === 'string' ? info.version.replace(/^v/, '') : null;
      return res.json({ version });
    } catch (error) {
      return res.status(500).json({
        version: null,
        error: error instanceof Error ? error.message : 'Failed to read OpenCode version',
      });
    }
  });

  app.put('/api/config/settings', async (req, res) => {
    try {
      const updated = await persistSettings(req.body ?? {}, { surface: settingsSurfaceOf(req) });
      res.json(updated);
    } catch (error) {
      console.error('[API:PUT /api/config/settings] Failed to save settings:', error);
      console.error('[API:PUT /api/config/settings] Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  app.get('/api/provider/disabled', (_req, res) => {
    try {
      return res.json({ providers: readDisabledProviders(null) });
    } catch (error) {
      console.error('Failed to read disabled providers:', error);
      return res.status(500).json({ error: 'Failed to read disabled providers' });
    }
  });

  app.put('/api/provider/:providerId/disabled', async (req, res) => {
    if (typeof req.body?.disabled !== 'boolean') {
      return res.status(400).json({ error: 'disabled must be true or false' });
    }
    try {
      const providers = setProviderDisabled(req.params.providerId, req.body.disabled, null);
      return res.json({ providers, ...buildAppliedResponse('Provider updated.') });
    } catch (error) {
      if (error?.statusCode === 400) return res.status(400).json({ error: error.message });
      console.error('Failed to update disabled providers:', error);
      return res.status(500).json({ error: 'Failed to update disabled providers' });
    }
  });

  app.get('/api/provider/:providerId/source', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      const resolved = await resolveProjectDirectory(req);
      if (resolved.directory) {
        directory = resolved.directory;
      } else if (requestedDirectory) {
        return res.status(400).json({ error: resolved.error });
      }

      const sources = getProviderSources(providerId, directory);
      const { getProviderAuth } = await getAuthLibrary();
      sources.sources.auth.exists = providerId === 'claude-code'
        ? getClaudeCliAuthStatus().connected
        : Boolean(await getProviderAuth(providerId));

      return res.json({
        providerId,
        sources: sources.sources,
        config: sources.config,
      });
    } catch (error) {
      console.error('Failed to get provider sources:', error);
      return res.status(500).json({ error: error.message || 'Failed to get provider sources' });
    }
  });

  const refuseInEnterpriseMode = (_req, res, next) => (
    isEnterpriseMode() ? res.status(403).json({ error: ENTERPRISE_MODE_ERROR, code: 'enterprise_mode' }) : next()
  );
  app.use((req, res, next) => (
    isProviderConnectRequest(req.method, req.path) ? refuseInEnterpriseMode(req, res, next) : next()
  ));

  app.use((req, res, next) => (
    isCredentialListRequest(req.method, req.path)
      ? res.status(403).json({ error: CREDENTIAL_LIST_ERROR, code: 'credential_list_refused' })
      : next()
  ));

  app.use((req, res, next) => {
    const refusal = vcsInitRefusal(req.method, req.originalUrl, req.headers);
    return refusal ? res.status(400).json(vcsInitRefusalBody(refusal)) : next();
  });

  app.put('/api/provider', refuseInEnterpriseMode, async (req, res) => {
    try {
      const providerID = typeof req.body?.providerID === 'string'
        ? req.body.providerID.trim()
        : (typeof req.body?.providerId === 'string' ? req.body.providerId.trim() : '');
      const config = req.body?.config;
      const scope = typeof req.body?.scope === 'string' ? req.body.scope : 'user';

      if (!providerID) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return res.status(400).json({ error: 'Provider config is required' });
      }
      if (scope !== 'user' && scope !== 'project' && scope !== 'custom') {
        return res.status(400).json({ error: 'Invalid scope' });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      if (scope === 'project' || requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error || 'Working directory is required' });
        }
        directory = resolved.directory;
      } else {
        const resolved = await resolveProjectDirectory(req);
        if (resolved.directory) {
          directory = resolved.directory;
        }
      }

      const { getProviderAuth } = await getAuthLibrary();
      const hasStoredAuth = req.body?.hasCredential === true || Boolean(await getProviderAuth(providerID));
      const upsertResult = upsertProviderConfig(providerID, config, directory, scope, { hasStoredAuth });

      return res.json({
        ...buildAppliedResponse(
          `Provider ${providerID} saved.`,
        ),
        providerId: upsertResult.providerId,
        path: upsertResult.path,
        config: upsertResult.config,
      });
    } catch (error) {
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
      console.error('Failed to upsert provider config:', error);
      return res.status(status).json({ error: error.message || 'Failed to save provider config' });
    }
  });

  app.post('/api/provider/discover-models', refuseInEnterpriseMode, async (req, res) => {
    try {
      const providerID = typeof req.body?.providerID === 'string' ? req.body.providerID.trim() : '';
      let storedApiKey = null;
      let storedBaseURL;
      if (providerID) {
        try {
          const { getProviderAuth } = await getAuthLibrary();
          const storedAuth = await getProviderAuth(providerID);
          storedApiKey = storedAuth?.type === 'api' && typeof storedAuth.key === 'string' ? storedAuth.key : null;
          const { value: rawProvider } = readSectionEntry(readConfigLayers().mergedConfig, 'providers', providerID);
          const providerEntity = rawProvider ? toProviderEntity(rawProvider) : null;
          storedBaseURL = providerEntity?.settings?.baseURL;
          if (!storedApiKey) {
            const envName = providerEntity?.env?.find((name) => process.env[name]) ?? providerEntity?.env?.[0];
            storedApiKey = providerEntity?.settings?.apiKey || (envName ? `{env:${envName}}` : null);
          }
        } catch {
          storedApiKey = null;
        }
      }
      return res.json(await discoverProviderModels(req.body, { storedApiKey, storedBaseURL }));
    } catch (error) {
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : 'Failed to discover provider models',
        code: typeof error?.code === 'string' ? error.code : 'discovery_failed',
      });
    }
  });

  app.get('/api/config/websearch', async (req, res) => {
    try {
      const resolved = await resolveProjectDirectory(req);
      return res.json(getWebSearchSource(resolved.directory || null));
    } catch (error) {
      console.error('Failed to read the web search config source:', error);
      return res.status(500).json({ error: error.message || 'Failed to read the web search config source' });
    }
  });

  app.put('/api/config/websearch', (req, res) => {
    const selection = parseWebSearchSelection(req.body?.selection);
    if (selection === undefined) {
      return res.status(400).json({ error: 'selection must be false, null, "random" or a provider id' });
    }
    try {
      const result = setWebSearchSelection(selection);
      return res.json({ success: true, changed: result.changed });
    } catch (error) {
      console.error('Failed to save the web search choice:', error);
      return res.status(500).json({ error: error.message || 'Failed to save the web search choice' });
    }
  });

  app.put('/api/config/warming', (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    try {
      const result = setWarmingEnabled(enabled);
      return res.json({ success: true, changed: result.changed });
    } catch (error) {
      console.error('Failed to save session warming:', error);
      return res.status(500).json({ error: error.message || 'Failed to save session warming' });
    }
  });

  app.put('/api/config/compaction', (req, res) => {
    const parsed = compactionUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'buffer must be a token count, a share such as "20%" or null, keepTokens a token count or null, auto and background booleans' });
    }
    try {
      const result = setCompactionSettings(parsed.data);
      return res.json({ success: true, changed: result.changed });
    } catch (error) {
      console.error('Failed to save compaction settings:', error);
      return res.status(500).json({ error: error.message || 'Failed to save compaction settings' });
    }
  });

  app.delete('/api/provider/:providerId/auth', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const scope = typeof req.query?.scope === 'string' ? req.query.scope : 'auth';
      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;
      let directory = null;

      if (scope === 'project' || requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      } else {
        const resolved = await resolveProjectDirectory(req);
        if (resolved.directory) {
          directory = resolved.directory;
        }
      }

      let removed = false;
      if (scope === 'auth') {
        return res.status(409).json({
          error: 'OpenCode 2 stores provider credentials itself. Disconnect the provider in Settings, which asks OpenCode to remove it.',
          code: 'PROVIDER_CREDENTIAL_OWNED_BY_OPENCODE',
        });
      } else if (scope === 'user' || scope === 'project' || scope === 'custom') {
        removed = removeProviderConfig(providerId, directory, scope);
      } else if (scope === 'all') {
        const userRemoved = removeProviderConfig(providerId, directory, 'user');
        const projectRemoved = directory ? removeProviderConfig(providerId, directory, 'project') : false;
        const customRemoved = removeProviderConfig(providerId, directory, 'custom');
        removed = userRemoved || projectRemoved || customRemoved;
      } else {
        return res.status(400).json({ error: 'Invalid scope' });
      }

      if (removed) {
        return res.json({
          success: true,
          removed,
          ...buildAppliedResponse('Provider disconnected successfully.'),
        });
      }

      return res.json({
        success: true,
        removed,
        requiresReload: false,
        message: 'Provider was not connected',
      });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect provider' });
    }
  });

  const AGENTS_MD_PATH = path.join(OPENCODE_CONFIG_DIR, 'AGENTS.md');
  const MAX_BEHAVIOR_PROMPT_SIZE = 1024 * 1024;

  app.get('/api/behavior/agents-md', async (_req, res) => {
    try {
      try {
        await fs.promises.access(AGENTS_MD_PATH);
      } catch {
        return res.json({ content: '', exists: false, path: AGENTS_MD_PATH });
      }
      const content = await fs.promises.readFile(AGENTS_MD_PATH, 'utf8');
      return res.json({ content, exists: true, path: AGENTS_MD_PATH });
    } catch (error) {
      console.error('Failed to read AGENTS.md:', error);
      return res.status(500).json({ error: 'Failed to read AGENTS.md' });
    }
  });

  app.put('/api/behavior/agents-md', async (req, res) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';

      if (content.length > MAX_BEHAVIOR_PROMPT_SIZE) {
        return res.status(413).json({ error: `Content exceeds maximum size of ${MAX_BEHAVIOR_PROMPT_SIZE} bytes` });
      }

      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'expectedContent')) {
        const expected = req.body.expectedContent;
        let current = null;
        try {
          current = await fs.promises.readFile(AGENTS_MD_PATH, 'utf8');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (current !== expected) {
          return res.status(409).json({
            error: 'AGENTS.md changed on disk since it was loaded',
            code: 'AGENTS_MD_CONFLICT',
          });
        }
      }

      const parentDir = path.dirname(AGENTS_MD_PATH);
      try {
        await fs.promises.access(parentDir);
      } catch {
        await fs.promises.mkdir(parentDir, { recursive: true });
      }

      await fs.promises.writeFile(AGENTS_MD_PATH, content, 'utf8');

      return res.json(buildAppliedResponse(
        'AGENTS.md saved.',
      ));
    } catch (error) {
      console.error('Failed to write AGENTS.md:', error);
      return res.status(500).json({ error: error.message || 'Failed to write AGENTS.md' });
    }
  });
};
