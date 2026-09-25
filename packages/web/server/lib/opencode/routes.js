import { readOpenCodeInfo, isSupportedOpenCodeVersion } from './compatibility.js';
import express from 'express';
import { createProjectIdFromPath } from '../projects/project-id.js';
import fs from 'fs';
import path from 'path';
import {
  buildAppliedResponse,
} from './config-mutation-response.js';
import { getClaudeCliAuthStatus } from './claude-cli-auth.js';
import { OPENCODE_CONFIG_DIR } from './shared.js';
import { settingsSurfaceOf } from './settings-files.js';
import { parseWebSearchSelection } from './config-v2.js';
import { getWebSearchSource, setWarmingEnabled, setWebSearchSelection } from './websearch-config.js';

export const registerOpenCodeRoutes = (app, dependencies) => {
  const {
    crypto,
    getOpenCodeResolutionSnapshot,
    getOpenCodeUpgradeCapability,
    upgradeOpenCodeCli,
    getOpenCodeCompatibility,
    installOpenCodeV2,
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    validateDirectoryPath,
    resolveProjectDirectory,
    getProviderSources,
    removeProviderConfig,
    upsertProviderConfig,
    refreshOpenCodeAfterConfigChange,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fsPromises = fs.promises,
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

  // OpenCode 2.x publishes as `@opencode/cli` on npm and has no GitHub
  // release assets, so the registry is the one source of "latest".
  const fetchLatestOpenCodeVersion = async () => {
    const response = await fetch('https://registry.npmjs.org/@opencode%2Fcli/latest', {
      headers: { Accept: 'application/json' },
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
      // The surface kind resolves the per-surface profile keys; absent means base.
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
      return res.status(409).json({
        success: false,
        code: bundled ? 'OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER' : 'OPENCODE_UPGRADE_UNSUPPORTED',
        error: bundled
          ? 'OpenCode is bundled with OpenChamber Desktop and updates with the app.'
          : 'This OpenCode runtime cannot be upgraded by OpenChamber.',
      });
    }
    try {
      // Multiple tabs share one installation. Clear both success and failure so
      // a later explicit attempt can run again.
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
      // Whether a newer OpenCode exists and whether OpenChamber can install it
      // are two answers: the UI announces the version either way and offers
      // the Update action only when `upgrade.supported` is true.
      const capability = getOpenCodeUpgradeCapability();
      const [healthResponse, latestVersion] = await Promise.all([
        fetch(buildOpenCodeUrl('/api/info', ''), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
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
      // A bundled binary updates together with the desktop app, so a newer
      // OpenCode is not something the user can act on: never announce it.
      const available = capability.reason === 'bundled' ? false : compareVersions(latestVersion, currentVersion) > 0;
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

  // OpenCode 2.0.8 removed `GET /api/health`; `GET /api/info` replaces it and a
  // 200 from it is the readiness signal (there is no `healthy` field any more).
  // OpenChamber's own `{ healthy }` response shape stays as its clients know it.
  app.get('/api/opencode/health', async (_req, res) => {
    try {
      const healthResponse = await fetch(buildOpenCodeUrl('/api/info', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      });
      const info = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return res.status(healthResponse.status).json({
          healthy: false,
          error: info?.error || healthResponse.statusText || 'OpenCode health check failed',
        });
      }
      const parsed = await readOpenCodeInfo(Response.json(info));
      return res.json({ healthy: parsed !== null && isSupportedOpenCodeVersion(parsed.version) });
    } catch (error) {
      return res.status(503).json({
        healthy: false,
        error: error instanceof Error ? error.message : 'OpenCode health check failed',
      });
    }
  });

  app.get('/api/opencode/version', async (_req, res) => {
    try {
      const healthResponse = await fetch(buildOpenCodeUrl('/api/info', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
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
      const auth = getProviderAuth(providerId);
      sources.sources.auth.exists = providerId === 'claude-code'
        ? getClaudeCliAuthStatus().connected
        : Boolean(auth);

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

  app.put('/api/provider', async (req, res) => {
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
      const hasStoredAuth = Boolean(getProviderAuth(providerID));
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

  // The web search choice (`websearch` in OpenCode config). OpenCode watches
  // the file and announces `config.updated`, so nothing restarts.
  // Whether a project config decides `websearch` for the directory, so
  // Settings can say so instead of letting a write snap back.
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

  // Session warming (`warming` in OpenCode config), written like the web
  // search choice above. Settings reads the effective value from OpenCode.
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

      // OpenCode 2.x owns credentials: it imported `auth.json` once and now
      // keeps them in its own store behind `/api/credential`. OpenChamber can
      // still remove a provider's CONFIG (those files are ours), but a
      // credential has to be removed where it lives.
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

  app.post('/api/opencode/directory', async (req, res) => {
    try {
      const requestedPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      if (req.body?.create === true) {
        await fsPromises.mkdir(path.resolve(requestedPath), { recursive: true });
      }

      const validated = await validateDirectoryPath(requestedPath);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }

      const resolvedPath = validated.directory;
      const currentSettings = await readSettingsFromDisk();
      const existingProjects = sanitizeProjects(currentSettings.projects) || [];
      const existing = existingProjects.find((project) => project.path === resolvedPath) || null;

      const nextProjects = existing
        ? existingProjects
        : [
            ...existingProjects,
            {
              id: createProjectIdFromPath(resolvedPath),
              path: resolvedPath,
              addedAt: Date.now(),
              lastOpenedAt: Date.now(),
            },
          ];

      const activeProjectId = existing ? existing.id : nextProjects[nextProjects.length - 1].id;

      const updated = await persistSettings({
        projects: nextProjects,
        activeProjectId,
        lastDirectory: resolvedPath,
      });

      return res.json({
        success: true,
        restarted: false,
        path: resolvedPath,
        settings: updated,
      });
    } catch (error) {
      console.error('Failed to update OpenCode working directory:', error);
      return res.status(500).json({ error: error.message || 'Failed to update working directory' });
    }
  });

  // Behavior / Global AGENTS.md endpoints
  const AGENTS_MD_PATH = path.join(OPENCODE_CONFIG_DIR, 'AGENTS.md');
  const MAX_BEHAVIOR_PROMPT_SIZE = 1024 * 1024; // 1 MB

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

      // Ensure parent directory exists
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
