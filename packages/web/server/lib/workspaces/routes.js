import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import {
  WorkspaceArtifactCache,
  applyWorkspaceArtifact,
  createArtifactReview,
  parseWorkspaceArtifact,
} from './structured-artifact.js';
import { buildPluginOptions, readWorkspaceSettings } from './policy.js';
import { isWorkspacePluginEntry, WORKSPACE_PLUGIN_PACKAGE } from './plugin-identity.js';
import { createWorkspaceSessionHandoff, WorkspaceHandoffJournal } from './session-handoff.js';

const WORKSPACE_ADAPTER_PROBE_TIMEOUT_MS = 10_000;
const WORKSPACE_CREATE_STATUS_REQUEST_TIMEOUT_MS = 3_000;
const WORKSPACE_CREATE_STATUS_POLL_INTERVAL_MS = 250;
const WORKSPACE_CREATE_STATUS_MAX_ATTEMPTS = 40;
const WORKSPACE_PLUGIN_RESOURCE_PATH = path.join('opencode-container-workspace', 'src', 'plugin.js');
const SECURE_WORKSPACE_PROVIDERS = new Set(['docker', 'kubernetes', 'apple-container']);

export function resolveWorkspacePluginSpec(options = {}) {
  const env = options.env ?? process.env;
  const explicit = typeof env.OPENCHAMBER_WORKSPACE_PLUGIN_PATH === 'string' ? env.OPENCHAMBER_WORKSPACE_PLUGIN_PATH.trim() : '';
  if (explicit) return explicit;
  const resolved = fileURLToPath(options.resolvedSpecUrl ?? import.meta.resolve(WORKSPACE_PLUGIN_PACKAGE));
  if (!resolved.includes('.asar')) return resolved;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const resourceCandidate = resourcesPath ? path.join(resourcesPath, WORKSPACE_PLUGIN_RESOURCE_PATH) : '';
  if (resourceCandidate && fs.existsSync(resourceCandidate)) return resourceCandidate;
  const unpackedCandidate = resolved.replace(/\.asar([/\\])/, '.asar.unpacked$1');
  if (unpackedCandidate !== resolved && fs.existsSync(unpackedCandidate)) return unpackedCandidate;
  throw new Error('Secure workspace plugin is inside app.asar and no unpacked plugin resource is available');
}

async function loadWorkspaceOperationsFactory() {
  try {
    const operationsSpecifier = `${WORKSPACE_PLUGIN_PACKAGE}/operations`;
    const module = await import(/* @vite-ignore */ operationsSpecifier);
    if (typeof module.createWorkspaceProviderOperations !== 'function') throw new Error('operations factory is missing');
    return module.createWorkspaceProviderOperations;
  } catch (error) {
    throw Object.assign(new Error(`Secure workspace provider operations are unavailable in the pinned plugin package: ${safeErrorMessage(error, 'incompatible package')}`), { statusCode: 503 });
  }
}

function safeErrorMessage(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/(OPENCHAMBER_WORKSPACE_AUTH_TOKEN=)[^\s]+/g, '$1[redacted]')
    .replace(/(x-openchamber-workspace-token[:=]\s*)[^\s]+/gi, '$1[redacted]')
    .replace(/(token[:=]\s*)[A-Za-z0-9._~+/-]{16,}/gi, '$1[redacted]');
}

function reauthBodyHash(payload) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

async function atomicWritePrivateJson(file, value) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, file);
    await fs.promises.chmod(file, 0o600);
    try {
      const directoryHandle = await fs.promises.open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch {
      // Directory fsync is not supported by every platform/filesystem.
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function createCompatibilityResult({ configured, spec, adapterProbe, boundary }) {
  const adapterKinds = adapterProbe.adapters.map((adapter) => adapter?.kind ?? adapter?.id ?? adapter?.type).filter(Boolean);
  const active = adapterProbe.ok && adapterKinds.some((kind) => SECURE_WORKSPACE_PROVIDERS.has(kind));
  if (boundary?.supported === false) {
    return {
      configured,
      active: false,
      supported: false,
      adapterKinds,
      spec,
      status: configured ? 'pending-activation' : 'not-configured',
      error: boundary.error,
      diagnostics: boundary.diagnostics ?? [],
      handoffSupported: false,
    };
  }
  return {
    configured,
    active,
    supported: adapterProbe.status !== 404 && adapterProbe.status !== 501,
    adapterKinds,
    spec,
    status: active ? 'active' : configured ? 'pending-activation' : 'not-configured',
    error: adapterProbe.error,
    diagnostics: boundary?.diagnostics ?? [],
    handoffSupported: true,
  };
}

async function loadOpenCodeWorkspace({ id, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders, createClient = createOpencodeClient }) {
  const client = createClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    directory: directory || undefined,
    headers: getOpenCodeAuthHeaders(),
  });
  const response = await client.experimental.workspace.list(directory ? { directory } : undefined);
  if (response?.error) throw new Error('Failed to list OpenCode workspaces');
  if (!Array.isArray(response?.data)) throw new Error('OpenCode returned an invalid workspace list');
  const workspace = response.data.find((item) => item?.id === id);
  if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
  return workspace;
}

function authoritativeIdentity(workspace) {
  if (!workspace || typeof workspace !== 'object' || typeof workspace.id !== 'string' || !workspace.id || typeof workspace.projectID !== 'string' || !workspace.projectID || !SECURE_WORKSPACE_PROVIDERS.has(workspace.type)) {
    throw Object.assign(new Error('Workspace record has invalid authoritative identity'), { statusCode: 409 });
  }
  const metadata = workspace.extra;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.version !== 1 || metadata.provider !== workspace.type || metadata.controlPlaneWorkspaceID !== workspace.id || metadata.projectID !== workspace.projectID || typeof metadata.providerResourceID !== 'string' || !metadata.providerResourceID) {
    throw Object.assign(new Error('Workspace metadata does not match the authoritative workspace record'), { statusCode: 409 });
  }
  return {
    controlPlaneWorkspaceID: workspace.id,
    providerResourceID: metadata.providerResourceID,
    projectID: workspace.projectID,
    provider: workspace.type,
  };
}

async function verifiedAuthoritativeWorkspace(workspace, operations) {
  try {
    authoritativeIdentity(workspace);
    return workspace;
  } catch (error) {
    const metadata = workspace?.extra;
    const recoverableMismatch = workspace && typeof workspace.id === 'string' && workspace.id
      && typeof workspace.projectID === 'string' && workspace.projectID
      && SECURE_WORKSPACE_PROVIDERS.has(workspace.type)
      && metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      && metadata.version === 1 && metadata.provider === workspace.type
      && metadata.projectID === workspace.projectID
      && typeof metadata.providerResourceID === 'string' && metadata.providerResourceID
      && typeof metadata.controlPlaneWorkspaceID === 'string' && metadata.controlPlaneWorkspaceID
      && metadata.controlPlaneWorkspaceID !== workspace.id;
    if (!recoverableMismatch || typeof operations?.adoptWorkspace !== 'function') throw error;
    const adopted = await operations.adoptWorkspace(workspace);
    const identity = authoritativeIdentity(adopted);
    if (adopted.id !== workspace.id || identity.providerResourceID !== metadata.providerResourceID || identity.projectID !== metadata.projectID || identity.provider !== metadata.provider) {
      throw Object.assign(new Error('Workspace recovery operation returned a mismatched identity'), { statusCode: 409 });
    }
    return adopted;
  }
}

export function registerWorkspaceRoutes(app, dependencies) {
  const {
    validateDirectoryPath,
    readSettingsFromDiskMigrated,
    persistSettings,
    restoreSettingsFields,
    sanitizeSettingsUpdate,
    sanitizeProjects = (projects) => projects,
    openchamberDataDir = path.join(process.cwd(), '.openchamber'),
    refreshOpenCodeAfterConfigChange,
    listPluginEntries,
    createPluginEntry,
    updatePluginEntry,
    deletePluginEntry,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    workspacePluginSpec,
    resolveWorkspacePluginSpec: resolvePluginSpec = resolveWorkspacePluginSpec,
    createWorkspaceProviderOperations,
    workspaceOperationsLoader = loadWorkspaceOperationsFactory,
    exportArtifactCache,
    createOpenCodeClient,
    beforeApplyReplace,
    uiAuthController,
    tunnelAuthController,
    randomWorkspaceID = () => crypto.randomUUID(),
    workspaceCreateStatusRequestTimeoutMs = WORKSPACE_CREATE_STATUS_REQUEST_TIMEOUT_MS,
    workspaceCreateStatusPollIntervalMs = WORKSPACE_CREATE_STATUS_POLL_INTERVAL_MS,
    workspaceCreateStatusMaxAttempts = WORKSPACE_CREATE_STATUS_MAX_ATTEMPTS,
    getWorkspaceRuntimeBoundary = () => ({ supported: true, diagnostics: [] }),
    handoffJournal,
    randomHandoffID,
  } = dependencies;
  const workspaceDataRoot = path.join(openchamberDataDir, 'workspace-apply');
  const transactionRoot = path.join(workspaceDataRoot, 'transactions');
  const lockRoot = path.join(workspaceDataRoot, 'locks');
  const artifactCache = exportArtifactCache ?? new WorkspaceArtifactCache({ rootDirectory: path.join(openchamberDataDir, 'workspace-exports') });
  const operationJournal = handoffJournal ?? new WorkspaceHandoffJournal({ rootDirectory: path.join(openchamberDataDir, 'workspace-handoffs') });
  const settingsTransactionFile = path.join(openchamberDataDir, 'workspace-settings-transaction.json');
  let settingsMutationQueue = Promise.resolve();

  const resolvedWorkspacePluginSpec = () => workspacePluginSpec ?? resolvePluginSpec();
  const workspacePluginEntries = (pluginSpec) => listPluginEntries(null).filter((entry) => isWorkspacePluginEntry(entry, pluginSpec));
  const restoreWorkspaceConfiguration = async ({ previousSettings, previousEntries, pluginSpec }) => {
    await restoreSettingsFields(previousSettings, 'secureWorkspaces');
    for (const entry of workspacePluginEntries(pluginSpec)) deletePluginEntry(entry.id, null);
    for (const entry of previousEntries) {
      createPluginEntry({ spec: entry.spec, scope: entry.scope, options: entry.options }, null);
    }
  };
  const clearSettingsTransaction = async () => {
    await fs.promises.rm(settingsTransactionFile, { force: true });
    try {
      const directoryHandle = await fs.promises.open(path.dirname(settingsTransactionFile), 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch {
      // Directory fsync is not supported by every platform/filesystem.
    }
  };
  const recoverSettingsTransaction = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(settingsTransactionFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    let transaction;
    try {
      transaction = JSON.parse(raw);
    } catch {
      throw new Error('Secure Workspace settings transaction journal is corrupt');
    }
    if (!transaction || transaction.version !== 1 || transaction.phase !== 'prepared') {
      throw new Error('Secure Workspace settings transaction journal is invalid');
    }
    if (!transaction.previousSettings || typeof transaction.previousSettings !== 'object' || !Array.isArray(transaction.previousEntries) || typeof transaction.pluginSpec !== 'string' || !transaction.pluginSpec) {
      throw new Error('Secure Workspace settings transaction journal is invalid');
    }
    if (Object.keys(transaction.previousSettings).some((key) => !key.startsWith('secureWorkspaces'))
      || transaction.previousEntries.some((entry) => !entry || typeof entry !== 'object' || !isWorkspacePluginEntry(entry, transaction.pluginSpec))) {
      throw new Error('Secure Workspace settings transaction journal is invalid');
    }
    await restoreWorkspaceConfiguration(transaction);
    await clearSettingsTransaction();
  };
  const settingsRecoveryPromise = recoverSettingsTransaction();
  void settingsRecoveryPromise.catch((error) => {
    console.error('[Secure Workspaces] Settings transaction recovery failed:', safeErrorMessage(error, 'recovery failed'));
  });

  function principalFor(context) {
    if (context?.type === 'client' && context.clientId) return `client:${context.clientId}`;
    if (context?.type === 'session' && context.token) return `session:${crypto.createHash('sha256').update(context.token).digest('hex')}`;
    return null;
  }

  function requireSupportedBoundary(res) {
    const boundary = getWorkspaceRuntimeBoundary();
    if (boundary?.supported !== false) return true;
    res.status(501).json({ error: boundary.error || 'Secure Workspace management is unavailable for this OpenCode runtime', diagnostics: boundary.diagnostics ?? [] });
    return false;
  }

  async function authorizePrivilegedRequest(req, res, capability, operation, project, payload) {
    if (!requireSupportedBoundary(res)) return false;
    if (!uiAuthController?.resolveAuthContext || !uiAuthController?.consumeReauthProof) {
      res.status(500).json({ error: 'Workspace authorization is unavailable' });
      return false;
    }
    const context = await uiAuthController.resolveAuthContext(req, res, { allowClientAuth: true, allowUrlToken: false });
    if (!context) {
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }
    const capabilities = Array.isArray(context.client?.capabilities) ? context.client.capabilities : [];
    const requestScope = tunnelAuthController?.classifyRequestScope?.(req);
    if (context.type === 'session' && (requestScope === 'tunnel' || requestScope === 'unknown-public')) {
      res.status(403).json({ error: 'Host workspace administration requires a host UI session' });
      return false;
    }
    if (context.type !== 'session' && !capabilities.includes(capability)) {
      res.status(403).json({ error: `Client capability required: ${capability}`, requiredCapability: capability });
      return false;
    }
    const validProof = await uiAuthController.consumeReauthProof(req, { operation, project, bodyHash: reauthBodyHash(payload) });
    if (!validProof) {
      res.status(428).json({ error: 'Reauthentication required', reauthRequired: true, operation, project });
      return false;
    }
    return true;
  }

  async function authorizeCapabilityRequest(req, res, capability, { allowUnsupported = false } = {}) {
    if (!allowUnsupported && !requireSupportedBoundary(res)) return null;
    if (!uiAuthController?.resolveAuthContext) {
      res.status(500).json({ error: 'Workspace authorization is unavailable' });
      return null;
    }
    const context = await uiAuthController.resolveAuthContext(req, res, { allowClientAuth: true, allowUrlToken: false });
    if (!context) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    const capabilities = Array.isArray(context.client?.capabilities) ? context.client.capabilities : [];
    const requestScope = tunnelAuthController?.classifyRequestScope?.(req);
    if (context.type === 'session' && (requestScope === 'tunnel' || requestScope === 'unknown-public')) {
      res.status(403).json({ error: 'Workspace access requires a capability-scoped client' });
      return null;
    }
    if (context.type !== 'session' && !capabilities.includes(capability)) {
      res.status(403).json({ error: `Client capability required: ${capability}`, requiredCapability: capability });
      return null;
    }
    const principal = principalFor(context);
    if (!principal) {
      res.status(401).json({ error: 'Authenticated principal is required' });
      return null;
    }
    return { context, principal };
  }

  async function persistedContext(directory, workspace) {
    await settingsRecoveryPromise;
    const diskSettings = await readSettingsFromDiskMigrated();
    const projects = sanitizeProjects(diskSettings?.projects) || [];
    let project;
    if (directory) {
      const validation = await validateDirectoryPath(directory);
      if (!validation.ok) throw Object.assign(new Error(validation.error || 'Invalid directory'), { statusCode: 400 });
      project = projects.find((candidate) => candidate.path === validation.directory);
    } else if (workspace) {
      project = projects.find((candidate) => candidate.id === workspace.projectID || candidate.path === workspace.directory);
    } else {
      project = projects.find((candidate) => candidate.id === diskSettings?.activeProjectId) ?? projects[0];
    }
    if (!project?.path) throw Object.assign(new Error('A canonical persisted OpenChamber project is required'), { statusCode: 409 });
    const validation = await validateDirectoryPath(project.path);
    if (!validation.ok || validation.directory !== project.path) throw Object.assign(new Error(validation.error || 'Persisted project directory is invalid'), { statusCode: 409 });
    return { project, directory: validation.directory, settings: readWorkspaceSettings(diskSettings) };
  }

  async function operationsFor(context) {
    const factory = createWorkspaceProviderOperations ?? await workspaceOperationsLoader();
    return factory({ policy: buildPluginOptions(context.settings, { requireComplete: true }), sourceDirectory: context.directory });
  }

  async function sdkClient(directory) {
    const factory = createOpenCodeClient ?? createOpencodeClient;
    return factory({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), directory: directory || undefined, headers: getOpenCodeAuthHeaders() });
  }

  const handoff = createWorkspaceSessionHandoff({
    journal: operationJournal,
    createClient: sdkClient,
    persistedContext,
    loadWorkspace: async (id, directory) => {
      const workspace = await loadOpenCodeWorkspace({ id, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders, createClient: createOpenCodeClient });
      authoritativeIdentity(workspace);
      return workspace;
    },
    workspaceStatus: async (client, directory) => {
      const result = await client.experimental.workspace.status({ directory });
      if (result?.error || !Array.isArray(result?.data)) throw new Error('Failed to load authoritative workspace status');
      return result.data;
    },
    ...(randomHandoffID ? { randomID: randomHandoffID } : {}),
  });

  async function compensateCreate({ id, context, client }) {
    const diagnostics = [];
    let list;
    try {
      list = await client.experimental.workspace.list({ directory: context.directory });
      if (list?.error || !Array.isArray(list?.data)) throw new Error('Failed to query the authoritative workspace list');
    } catch (error) {
      diagnostics.push(`Authoritative row lookup failed: ${safeErrorMessage(error, 'unknown lookup failure')}`);
      return { completed: false, retryable: true, recordPresent: null, remainingResources: ['opencode-workspace-record:unknown'], diagnostics };
    }
    const workspace = list.data.find((item) => item?.id === id);
    if (!workspace) {
      diagnostics.push(`No authoritative OpenCode row exists for provisional workspace ${id}`);
      return { completed: true, retryable: false, recordPresent: false, remainingResources: [], diagnostics };
    }
    diagnostics.push(`Found provisional OpenCode row ${id}; starting provider cleanup`);
    try {
      const operations = await operationsFor(context);
      const verified = await verifiedAuthoritativeWorkspace(workspace, operations);
      const cleanup = await operations.cleanupWorkspace(verified);
      const remainingResources = Array.isArray(cleanup?.remainingResources) ? cleanup.remainingResources.filter((item) => typeof item === 'string') : [];
      diagnostics.push(...(Array.isArray(cleanup?.diagnostics) ? cleanup.diagnostics.filter((item) => typeof item === 'string') : []));
      if (cleanup?.ok !== true || remainingResources.length > 0) {
        diagnostics.push('Provider cleanup is incomplete; the exact OpenCode row was preserved for retry');
        return { completed: false, retryable: true, recordPresent: true, remainingResources, diagnostics };
      }
      const removed = await client.experimental.workspace.remove({ id, directory: context.directory });
      if (removed?.error || !removed?.data) throw new Error('Provider cleanup completed, but the exact OpenCode row could not be removed');
      diagnostics.push(`Removed provisional OpenCode row ${id} after complete provider cleanup`);
      return { completed: true, retryable: false, recordPresent: false, remainingResources: [], diagnostics };
    } catch (error) {
      diagnostics.push(`Compensation failed: ${safeErrorMessage(error, 'unknown compensation failure')}`);
      return { completed: false, retryable: true, recordPresent: true, remainingResources: Array.isArray(error?.remainingResources) ? error.remainingResources : [], diagnostics };
    }
  }

  async function waitForWorkspaceConnection(client, id, directory) {
    const diagnostics = [];
    for (let attempt = 0; attempt < workspaceCreateStatusMaxAttempts; attempt += 1) {
      try {
        const result = await client.experimental.workspace.status({ directory }, { signal: AbortSignal.timeout(workspaceCreateStatusRequestTimeoutMs) });
        if (result?.error || !Array.isArray(result?.data)) throw new Error('OpenCode returned an invalid workspace status response');
        const current = result.data.find((item) => item?.workspaceID === id);
        if (current?.status === 'connected') return { status: 'connected', diagnostics };
        if (current?.status === 'error' || current?.status === 'disconnected') return { status: current.status, diagnostics };
      } catch (error) {
        diagnostics.push(`Status attempt ${attempt + 1} failed: ${safeErrorMessage(error, 'unknown status failure')}`);
      }
      if (attempt + 1 < workspaceCreateStatusMaxAttempts && workspaceCreateStatusPollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, workspaceCreateStatusPollIntervalMs));
      }
    }
    return { status: 'timeout', diagnostics };
  }

  async function probeWorkspaceAdapters(directory = '') {
    try {
      const factory = createOpenCodeClient ?? createOpencodeClient;
      const client = factory({
        baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
        directory: directory || undefined,
        headers: getOpenCodeAuthHeaders(),
        fetch: (request) => fetch(request, { signal: AbortSignal.timeout(WORKSPACE_ADAPTER_PROBE_TIMEOUT_MS) }),
      });
      const response = await client.experimental.workspace.adapter.list(directory ? { directory } : undefined);
      if (response?.error) return { ok: false, status: response.response?.status ?? 500, adapters: [], error: response.response?.statusText || 'Workspace adapter probe failed' };
      return { ok: true, status: response.response?.status ?? 200, adapters: Array.isArray(response?.data) ? response.data : [], error: null };
    } catch (error) {
      return { ok: false, status: 0, adapters: [], error: safeErrorMessage(error, 'Failed to probe workspace adapters') };
    }
  }

  async function handleProviderValidation(req, res) {
    const source = req.method === 'POST' ? req.body ?? {} : req.query ?? {};
    const provider = typeof source.provider === 'string' ? source.provider : '';
    if (!await authorizePrivilegedRequest(req, res, 'workspace.admin', 'workspace.validate', 'host', { provider })) return;
    if (!SECURE_WORKSPACE_PROVIDERS.has(provider)) return res.status(400).json({ available: false, error: 'Unsupported workspace provider' });
    try {
      const context = await persistedContext('', null);
      return res.json(await (await operationsFor(context)).validateProvider(provider));
    } catch (error) {
      return res.status(error?.statusCode || 503).json({ available: false, error: safeErrorMessage(error, 'Workspace provider is unavailable') });
    }
  }
  app.get('/api/workspaces/providers/validate', handleProviderValidation);
  app.post('/api/workspaces/providers/validate', handleProviderValidation);

  app.get('/api/workspaces/compatibility', async (req, res) => {
    if (!await authorizeCapabilityRequest(req, res, 'workspace.read', { allowUnsupported: true })) return;
    try {
      await settingsRecoveryPromise;
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      const pluginSpec = workspacePluginSpec ?? (() => { try { return resolvePluginSpec(); } catch { return null; } })();
      const entries = listPluginEntries(null);
      const configuredEntry = entries.find((entry) => isWorkspacePluginEntry(entry, pluginSpec)) ?? entries.find((entry) => isWorkspacePluginEntry(entry, null));
      const boundary = getWorkspaceRuntimeBoundary();
      const adapterProbe = boundary?.supported === false ? { ok: false, status: 501, adapters: [], error: boundary.error } : await probeWorkspaceAdapters(directory);
      return res.json(createCompatibilityResult({ configured: Boolean(configuredEntry), spec: configuredEntry?.spec ?? pluginSpec ?? undefined, adapterProbe, boundary }));
    } catch (error) {
      return res.status(500).json({ error: safeErrorMessage(error, 'Failed to inspect workspace compatibility') });
    }
  });

  const handleWorkspaceCreate = async (req, res) => {
    const directorySource = typeof req.body?.directory === 'string' ? req.body.directory : req.query?.directory;
    const directory = typeof directorySource === 'string' ? directorySource.trim() : '';
    const type = typeof req.body?.type === 'string' ? req.body.type : '';
    const extra = req.body?.extra && typeof req.body.extra === 'object' && !Array.isArray(req.body.extra) ? req.body.extra : null;
    const payload = { type, directory, extra };
    if (!await authorizePrivilegedRequest(req, res, 'workspace.admin', 'workspace.create', directory || 'host', payload)) return;
    if (!SECURE_WORKSPACE_PROVIDERS.has(type)) return res.status(400).json({ error: 'Unsupported workspace provider' });
    let context;
    let client;
    const provisionalID = randomWorkspaceID();
    try {
      context = await persistedContext(directory, null);
      buildPluginOptions(context.settings, { requireComplete: true });
      client = await sdkClient(context.directory);
      const result = await client.experimental.workspace.create({ id: provisionalID, type, directory: context.directory, branch: null, extra: { image: context.settings.image } });
      if (result?.error || !result?.data) throw new Error(result?.response?.statusText || 'Failed to create workspace');
      if (result.data.id !== provisionalID) throw new Error('OpenCode returned a workspace with an unexpected provisional ID');
      const connection = await waitForWorkspaceConnection(client, provisionalID, context.directory);
      if (connection.status === 'connected') return res.status(201).json({ ...result.data, status: 'connected', provisional: false, retryable: false, diagnostics: connection.diagnostics });
      if (connection.status === 'timeout') {
        return res.status(202).json({ ...result.data, status: 'connecting', provisional: true, retryable: true, diagnostics: [...connection.diagnostics, `Workspace ${provisionalID} is still provisional; retry authoritative status before use`] });
      }
      const cause = new Error(`Workspace ${provisionalID} reported ${connection.status} before becoming connected`);
      cause.diagnostics = connection.diagnostics;
      throw cause;
    } catch (error) {
      const originalError = safeErrorMessage(error, 'Failed to create workspace');
      if (!context || !client) return res.status(error?.statusCode || 400).json({ error: originalError, provisionalID, retryable: false, diagnostics: [] });
      const compensation = await compensateCreate({ id: provisionalID, context, client });
      return res.status(error?.statusCode || 409).json({ error: originalError, provisionalID, retryable: compensation.retryable, compensation, remainingResources: compensation.remainingResources, diagnostics: [...(Array.isArray(error?.diagnostics) ? error.diagnostics : []), ...compensation.diagnostics] });
    }
  };
  app.post('/api/workspaces/create', handleWorkspaceCreate);
  app.post('/api/experimental/workspace', handleWorkspaceCreate);

  const handleWorkspaceCleanup = async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id : '';
    const directorySource = typeof req.body?.directory === 'string' ? req.body.directory : req.query?.directory;
    const directory = typeof directorySource === 'string' ? directorySource.trim() : '';
    const payload = { id, directory };
    if (!await authorizePrivilegedRequest(req, res, 'workspace.admin', 'workspace.cleanup', directory || 'host', payload)) return;
    try {
      let workspace = await loadOpenCodeWorkspace({ id, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders, createClient: createOpenCodeClient });
      const context = await persistedContext(directory, workspace);
      const operations = await operationsFor(context);
      workspace = await verifiedAuthoritativeWorkspace(workspace, operations);
      const cleanup = await operations.cleanupWorkspace(workspace);
      if (cleanup?.ok !== true || !Array.isArray(cleanup.remainingResources) || cleanup.remainingResources.length !== 0) {
        return res.status(409).json({ cleaned: false, retryable: true, error: 'Workspace provider cleanup is incomplete', remainingResources: Array.isArray(cleanup?.remainingResources) ? cleanup.remainingResources : [] });
      }
      const result = await (await sdkClient(context.directory)).experimental.workspace.remove({ id, directory: context.directory });
      if (result?.error || !result?.data) throw new Error('Provider cleanup succeeded, but the OpenCode workspace record could not be removed');
      return res.json({ cleaned: true, workspace: result.data, diagnostics: Array.isArray(cleanup.diagnostics) ? cleanup.diagnostics : [] });
    } catch (error) {
      return res.status(error?.statusCode || 409).json({ cleaned: false, retryable: true, error: safeErrorMessage(error, 'Failed to clean up workspace'), remainingResources: Array.isArray(error?.remainingResources) ? error.remainingResources : [] });
    }
  };
  app.delete('/api/workspaces/:id', handleWorkspaceCleanup);
  app.delete('/api/experimental/workspace/:id', handleWorkspaceCleanup);

  app.post('/api/workspaces/:id/reconcile', async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id : '';
    const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
    const payload = { id, directory };
    if (!await authorizePrivilegedRequest(req, res, 'workspace.admin', 'workspace.reconcile', directory || 'host', payload)) return;
    try {
      let workspace = await loadOpenCodeWorkspace({ id, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders, createClient: createOpenCodeClient });
      const context = await persistedContext(directory, workspace);
      const operations = await operationsFor(context);
      workspace = await verifiedAuthoritativeWorkspace(workspace, operations);
      const result = await operations.reconcileWorkspace(workspace);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Workspace provider returned invalid reconciliation diagnostics');
      const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics.filter((item) => typeof item === 'string') : [];
      const remainingResources = Array.isArray(result.remainingResources) ? result.remainingResources.filter((item) => typeof item === 'string') : [];
      return res.json({ reconciled: result.ok !== false && remainingResources.length === 0, status: typeof result.status === 'string' ? result.status : typeof result.state === 'string' ? result.state : undefined, diagnostics, remainingResources });
    } catch (error) {
      return res.status(error?.statusCode || 409).json({ reconciled: false, diagnostics: Array.isArray(error?.diagnostics) ? error.diagnostics : [], error: safeErrorMessage(error, 'Failed to reconcile workspace') });
    }
  });

  const requireWorkspaceCapability = (capability) => async (req, res, next) => { if (await authorizeCapabilityRequest(req, res, capability)) next(); };
  app.get('/api/experimental/workspace', requireWorkspaceCapability('workspace.read'));
  app.get('/api/experimental/workspace/adapter', requireWorkspaceCapability('workspace.read'));
  app.get('/api/experimental/workspace/status', requireWorkspaceCapability('workspace.read'));
  app.post('/api/experimental/workspace/sync-list', requireWorkspaceCapability('workspace.use'));

  app.post('/api/workspaces/handoffs/draft', async (req, res) => {
    const authorization = await authorizeCapabilityRequest(req, res, 'workspace.use');
    if (!authorization) return;
    try {
      const sourceSessionID = typeof req.body?.sourceSessionID === 'string' ? req.body.sourceSessionID : '';
      const projectID = typeof req.body?.projectID === 'string' ? req.body.projectID : '';
      const sourceWorkspaceID = typeof req.body?.sourceWorkspaceID === 'string' ? req.body.sourceWorkspaceID : null;
      const targetWorkspaceID = typeof req.body?.targetWorkspaceID === 'string' ? req.body.targetWorkspaceID : null;
      const directory = typeof req.body?.directory === 'string' ? req.body.directory : '';
      if (!sourceSessionID || !projectID) return res.status(400).json({ error: 'Source session and project are required' });
      const operation = await handoff.draft({ sourceSessionID, projectID, sourceWorkspaceID, targetWorkspaceID, directory }, authorization.principal);
      return res.status(201).json(operation);
    } catch (error) {
      return res.status(error?.statusCode || 409).json({ error: safeErrorMessage(error, 'Failed to create handoff draft'), staleDraft: error?.staleDraft === true, cleanupRequired: error?.cleanupRequired === true });
    }
  });

  app.post('/api/workspaces/handoffs/:operationID/commit', async (req, res) => {
    const authorization = await authorizeCapabilityRequest(req, res, 'workspace.use');
    if (!authorization) return;
    try {
      const operationID = req.params.operationID;
      if (req.body?.operationID !== operationID) return res.status(400).json({ error: 'Operation ID mismatch' });
      return res.json(await handoff.commit(req.body, authorization.principal));
    } catch (error) {
      return res.status(error?.statusCode || 409).json({ error: safeErrorMessage(error, 'Failed to commit handoff'), staleDraft: error?.staleDraft === true, cleanupRequired: error?.cleanupRequired === true });
    }
  });

  app.get('/api/workspaces/handoffs/:operationID', async (req, res) => {
    const authorization = await authorizeCapabilityRequest(req, res, 'workspace.use');
    if (!authorization) return;
    try {
      return res.json(await handoff.inspect(req.params.operationID, authorization.principal));
    } catch (error) {
      return res.status(error?.statusCode || 409).json({ error: safeErrorMessage(error, 'Failed to inspect handoff operation') });
    }
  });

  app.delete('/api/workspaces/handoffs/:operationID/target', async (req, res) => {
    const authorization = await authorizeCapabilityRequest(req, res, 'workspace.use');
    if (!authorization) return;
    try {
      return res.json(await handoff.cleanup(req.params.operationID, authorization.principal));
    } catch (error) {
      return res.status(error?.statusCode || 409).json({ error: safeErrorMessage(error, 'Failed to clean handoff target'), cleanupRequired: error?.cleanupRequired === true });
    }
  });

  app.get('/api/workspaces/:id/export', async (req, res) => {
    const requestedDirectory = typeof req.query.directory === 'string' ? req.query.directory : '';
    const binding = { id: req.params.id, directory: requestedDirectory };
    if (!await authorizePrivilegedRequest(req, res, 'workspace.admin', 'workspace.export', requestedDirectory || 'host', binding)) return;
    try {
      let workspace = await loadOpenCodeWorkspace({ id: req.params.id, directory: requestedDirectory, buildOpenCodeUrl, getOpenCodeAuthHeaders, createClient: createOpenCodeClient });
      const context = await persistedContext(requestedDirectory, workspace);
      const operations = await operationsFor(context);
      workspace = await verifiedAuthoritativeWorkspace(workspace, operations);
      const identity = authoritativeIdentity(workspace);
      const rawArtifact = await operations.exportWorkspace(workspace);
      const parsed = parseWorkspaceArtifact(rawArtifact, { ...identity, targetDirectory: context.directory });
      const review = createArtifactReview(parsed);
      const cached = await artifactCache.set(parsed);
      return res.json({ exportID: parsed.artifact.id, provider: parsed.artifact.provider, expiresAt: cached?.expiresAt ?? parsed.artifact.expiresAt, review });
    } catch (error) {
      return res.status(error?.statusCode || 400).json({ error: safeErrorMessage(error, 'Failed to export workspace changes') });
    }
  });

  app.post('/api/workspaces/exports/:exportID/apply', async (req, res) => {
    const exportID = typeof req.params.exportID === 'string' ? req.params.exportID : '';
    const directory = typeof req.body?.directory === 'string' ? req.body.directory : '';
    const workspaceID = typeof req.body?.workspaceID === 'string' ? req.body.workspaceID : '';
    const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
    const checkOnly = req.body?.checkOnly !== false;
    const binding = { directory, exportID, selections, workspaceID, checkOnly };
    if (!await authorizePrivilegedRequest(req, res, 'host.apply', 'host.apply', directory || 'host', binding)) return;
    try {
      const parsed = await artifactCache.get(exportID);
      if (!parsed) return res.status(410).json({ applied: false, checkOnly, error: 'Workspace export expired; re-export required' });
      if (workspaceID !== parsed.artifact.controlPlaneWorkspaceID) throw Object.assign(new Error('Workspace export does not match the selected workspace; re-export required'), { statusCode: 409 });
      let workspace = await loadOpenCodeWorkspace({ id: workspaceID, directory: parsed.artifact.targetDirectory, buildOpenCodeUrl, getOpenCodeAuthHeaders, createClient: createOpenCodeClient });
      const context = await persistedContext(directory, workspace);
      workspace = await verifiedAuthoritativeWorkspace(workspace, await operationsFor(context));
      const identity = authoritativeIdentity(workspace);
      parseWorkspaceArtifact(parsed.artifact, { ...identity, targetDirectory: context.directory });
      const result = await applyWorkspaceArtifact({ parsed, directory: context.directory, selections, checkOnly, transactionRoot, lockRoot, beforeReplace: beforeApplyReplace });
      if (result.applied) await artifactCache.delete(exportID);
      return res.json(result);
    } catch (error) {
      return res.status(error?.statusCode || 409).json({ applied: false, checkOnly, error: safeErrorMessage(error, 'Workspace export cannot be applied cleanly'), ...(error?.rollbackError ? { rollbackError: safeErrorMessage(error.rollbackError, 'Rollback incomplete') } : {}) });
    }
  });

  app.get('/api/workspaces/exports/:exportID/download', async (req, res) => {
    if (!await authorizeCapabilityRequest(req, res, 'workspace.admin')) return;
    const exportID = typeof req.params?.exportID === 'string' ? req.params.exportID : '';
    const workspaceID = typeof req.query?.workspaceID === 'string' ? req.query.workspaceID : '';
    try {
      const parsed = await artifactCache.get(exportID);
      if (!parsed) return res.status(410).json({ error: 'Workspace export expired; re-export required' });
      if (!workspaceID || workspaceID !== parsed.artifact.controlPlaneWorkspaceID) return res.status(409).json({ error: 'Workspace export does not match the selected workspace' });
      let workspace = await loadOpenCodeWorkspace({ id: workspaceID, directory: parsed.artifact.targetDirectory, buildOpenCodeUrl, getOpenCodeAuthHeaders, createClient: createOpenCodeClient });
      const context = await persistedContext(parsed.artifact.targetDirectory, workspace);
      workspace = await verifiedAuthoritativeWorkspace(workspace, await operationsFor(context));
      const identity = authoritativeIdentity(workspace);
      parseWorkspaceArtifact(parsed.artifact, { ...identity, targetDirectory: parsed.artifact.targetDirectory });
      const safeID = parsed.artifact.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'workspace-export';
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="workspace-export-${safeID}.json"`);
      res.setHeader('Content-Length', String(parsed.serialized.length));
      return res.send(parsed.serialized);
    } catch (error) {
      return res.status(error?.statusCode || 409).json({ error: safeErrorMessage(error, 'Workspace export cannot be downloaded') });
    }
  });

  app.delete('/api/workspaces/exports/:exportID', async (req, res) => {
    if (!await authorizeCapabilityRequest(req, res, 'workspace.admin')) return;
    const exportID = typeof req.params?.exportID === 'string' ? req.params.exportID : '';
    const workspaceID = typeof req.body?.workspaceID === 'string' ? req.body.workspaceID : '';
    try {
      const parsed = await artifactCache.get(exportID);
      if (!parsed) return res.status(410).json({ discarded: false, error: 'Workspace export expired; re-export required' });
      if (!workspaceID || workspaceID !== parsed.artifact.controlPlaneWorkspaceID) return res.status(409).json({ discarded: false, error: 'Workspace export does not match the selected workspace' });
      await artifactCache.delete(exportID);
      return res.json({ discarded: true });
    } catch (error) {
      return res.status(error?.statusCode || 500).json({ discarded: false, error: safeErrorMessage(error, 'Workspace export cannot be discarded') });
    }
  });

  app.post('/api/workspaces/settings', async (req, res) => {
    const rawChanges = req.body?.changes;
    if (!rawChanges || typeof rawChanges !== 'object' || Array.isArray(rawChanges)
      || Object.keys(rawChanges).some((key) => !key.startsWith('secureWorkspaces'))) {
      return res.status(400).json({ error: 'Only Secure Workspace settings may be changed by this route' });
    }
    let changes;
    try {
      changes = sanitizeSettingsUpdate(rawChanges);
    } catch (error) {
      return res.status(error?.statusCode || 400).json({ error: safeErrorMessage(error, 'Invalid Secure Workspace settings') });
    }
    if (Object.keys(changes).length !== Object.keys(rawChanges).length) {
      return res.status(400).json({ error: 'Invalid Secure Workspace settings' });
    }
    const binding = { activate: req.body?.activate === true, changes };
    const proofBinding = { activate: binding.activate, changes: rawChanges };
    if (!await authorizePrivilegedRequest(req, res, 'workspace.admin', 'workspace.configure', 'host', proofBinding)) return;

    const run = async () => {
      await settingsRecoveryPromise;
      const previousSettings = await readSettingsFromDiskMigrated();
      const pluginSpec = resolvedWorkspacePluginSpec();
      const previousEntries = workspacePluginEntries(pluginSpec);
      const previousWorkspaceSettings = Object.fromEntries(Object.entries(previousSettings).filter(([key]) => key.startsWith('secureWorkspaces')));
      const transaction = {
        version: 1,
        phase: 'prepared',
        pluginSpec,
        previousSettings: previousWorkspaceSettings,
        previousEntries: previousEntries.map((entry) => ({ spec: entry.spec, scope: entry.scope, options: entry.options })),
      };
      await atomicWritePrivateJson(settingsTransactionFile, transaction);
      try {
        const updated = await persistSettings(changes);
        const settings = readWorkspaceSettings(updated);
        const currentEntries = workspacePluginEntries(pluginSpec);
        for (const entry of currentEntries) deletePluginEntry(entry.id, null);

        if (settings.enabled) {
          createPluginEntry({ spec: pluginSpec, scope: 'user', options: buildPluginOptions(settings, { requireComplete: true }) }, null);
        }
        let activation = { reloaded: false, external: false };
        if (binding.activate) activation = await refreshOpenCodeAfterConfigChange(settings.enabled ? 'secure workspaces configured' : 'secure workspaces disabled');
        const boundary = getWorkspaceRuntimeBoundary();
        const compatibility = createCompatibilityResult({ configured: settings.enabled, spec: pluginSpec, adapterProbe: await probeWorkspaceAdapters(''), boundary });
        await clearSettingsTransaction();
        return res.json({
          configured: settings.enabled,
          enabled: settings.enabled,
          settings: updated,
          ...(settings.enabled ? { spec: pluginSpec } : {}),
          activated: binding.activate,
          active: compatibility.active,
          external: activation.external,
          manualRestartRequired: binding.activate && activation.external && !compatibility.active,
          compatibility,
        });
      } catch (error) {
        try {
          await restoreWorkspaceConfiguration(transaction);
          await clearSettingsTransaction();
        } catch (rollbackError) {
          console.error('[API:POST /api/workspaces/settings] Rollback failed:', safeErrorMessage(rollbackError, 'rollback failed'));
          return res.status(500).json({ error: 'Failed to configure secure workspaces and rollback was incomplete' });
        }
        return res.status(500).json({ error: safeErrorMessage(error, 'Failed to configure secure workspaces') });
      }
    };
    settingsMutationQueue = settingsMutationQueue.then(run, run);
    return settingsMutationQueue;
  });

  return settingsRecoveryPromise;
}
