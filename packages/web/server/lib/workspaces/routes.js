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
import { OrdinarySessionJournal, isUpstreamCreateWaitTimeout, startOrdinaryWorkspaceSession } from './ordinary-session-start.js';
import { WorkspaceSessionRouteStore } from './session-routes.js';
import { workspaceSetupSteps } from './setup-steps.js';

const WORKSPACE_ADAPTER_PROBE_TIMEOUT_MS = 10_000;
const WORKSPACE_CREATE_STATUS_REQUEST_TIMEOUT_MS = 3_000;
const WORKSPACE_CREATE_STATUS_POLL_INTERVAL_MS = 250;
// A Kubernetes workspace was measured taking about 80 seconds to create on Windows
// against a local cluster — pods, two seeded volumes, a gateway rollout and a
// port-forward — and the status it then reports is not instant either. Waiting ten
// seconds for it declared a healthy workspace timed out. The loop still returns the
// moment the workspace reports connected, so a longer ceiling only buys patience.
const WORKSPACE_CREATE_STATUS_MAX_ATTEMPTS = 240;
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
  const message = error instanceof Error
    ? error.message
    : typeof error?.data?.message === 'string'
      ? error.data.message
      : typeof error?.message === 'string'
        ? error.message
        : fallback;
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

const ISOLATION_VERDICTS = new Set(['enforced', 'not-enforced', 'inconclusive']);

/**
 * The verdict of an earlier isolation probe, which the provider carries forward because
 * the probe itself is too slow to run on a readiness check. Read as a field: matching on
 * diagnostic wording silently lost every passing verdict, which carries no diagnostics.
 */
function isolationVerdict(result) {
  const verdict = result?.isolation?.verdict;
  return ISOLATION_VERDICTS.has(verdict) ? { verdict } : null;
}

function platformProviders() {
  const providers = ['docker', 'kubernetes'];
  if (process.platform === 'darwin') providers.push('apple-container');
  return providers;
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
      platform: process.platform,
      platformProviders: platformProviders(),
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
    platform: process.platform,
    platformProviders: platformProviders(),
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

function recoverableIdentityMismatch(workspace) {
  const metadata = workspace?.extra;
  return Boolean(workspace && typeof workspace.id === 'string' && workspace.id
    && typeof workspace.projectID === 'string' && workspace.projectID
    && SECURE_WORKSPACE_PROVIDERS.has(workspace.type)
    && metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    && metadata.version === 1 && metadata.provider === workspace.type
    && metadata.projectID === workspace.projectID
    && typeof metadata.providerResourceID === 'string' && metadata.providerResourceID
    && typeof metadata.controlPlaneWorkspaceID === 'string' && metadata.controlPlaneWorkspaceID
    && metadata.controlPlaneWorkspaceID !== workspace.id);
}

async function verifiedAuthoritativeWorkspace(workspace, operations) {
  try {
    authoritativeIdentity(workspace);
    return workspace;
  } catch (error) {
    if (!recoverableIdentityMismatch(workspace) || typeof operations?.adoptWorkspace !== 'function') throw error;
    const metadata = workspace.extra;
    const adopted = await operations.adoptWorkspace(workspace);
    const identity = authoritativeIdentity(adopted);
    if (adopted.id !== workspace.id || identity.providerResourceID !== metadata.providerResourceID || identity.projectID !== metadata.projectID || identity.provider !== metadata.provider) {
      throw Object.assign(new Error('Workspace recovery operation returned a mismatched identity'), { statusCode: 409 });
    }
    return adopted;
  }
}

// Cleanup verification tolerates a control-plane ID drift without requiring a healthy
// adoption: a degraded workspace must remain deletable, and the identity drift is
// resolved by the plugin operations layer against persisted provider state.
function verifiedCleanupWorkspace(workspace) {
  try {
    authoritativeIdentity(workspace);
    return workspace;
  } catch (error) {
    if (!recoverableIdentityMismatch(workspace)) throw error;
    return workspace;
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
    randomWorkspaceID = () => `wrk_${crypto.randomUUID().replaceAll('-', '')}`,
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
  const ordinarySessionJournal = new OrdinarySessionJournal({ rootDirectory: path.join(openchamberDataDir, 'workspace-sessions') });
  const sessionRouteStore = new WorkspaceSessionRouteStore({ rootDirectory: path.join(openchamberDataDir, 'workspace-session-routes') });
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
  const canonicalJson = (value) => JSON.stringify(value, (key, item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item
  ));
  /**
   * Converges the OpenCode plugin registration with what persisted settings say it must
   * be. Registering a missing entry repairs an interrupted save or a restored profile,
   * where the persisted flag and the registration contradict each other. Rewriting an
   * entry whose options differ repairs a quieter drift: the entry materializes the
   * policy at the moment settings were last saved, so a policy default that moved since
   * — a repinned image digest — never reached OpenCode, and every new workspace kept
   * being built from the superseded image while the code pinned the new one. Nothing
   * else rewrites the entry, so without this the two copies drift apart forever.
   */
  const reconcilePluginRegistration = async () => {
    const persisted = await readSettingsFromDiskMigrated();
    const settings = readWorkspaceSettings(persisted);
    if (!settings.enabled) return;
    const pluginSpec = resolvedWorkspacePluginSpec();
    const entries = workspacePluginEntries(pluginSpec);
    const options = buildPluginOptions(settings, { requireComplete: true });
    if (entries.length === 0) {
      createPluginEntry({ spec: pluginSpec, scope: 'user', options }, null);
      console.log('[Secure Workspaces] Registered the workspace plugin, which enabled settings expected and OpenCode did not have');
      return;
    }
    if (entries.length === 1 && entries[0].scope === 'user' && canonicalJson(entries[0].options ?? null) === canonicalJson(options)) return;
    const transaction = {
      version: 1,
      phase: 'prepared',
      pluginSpec,
      previousSettings: Object.fromEntries(Object.entries(persisted).filter(([key]) => key.startsWith('secureWorkspaces'))),
      previousEntries: entries.map((entry) => ({ spec: entry.spec, scope: entry.scope, options: entry.options })),
    };
    await atomicWritePrivateJson(settingsTransactionFile, transaction);
    try {
      for (const entry of entries) deletePluginEntry(entry.id, null);
      createPluginEntry({ spec: pluginSpec, scope: 'user', options }, null);
      await clearSettingsTransaction();
      console.log('[Secure Workspaces] Rewrote the workspace plugin registration, whose options had fallen behind the current policy');
    } catch (error) {
      await restoreWorkspaceConfiguration(transaction);
      await clearSettingsTransaction();
      throw error;
    }
  };

  const settingsRecoveryPromise = recoverSettingsTransaction()
    .then(() => reconcilePluginRegistration())
    .catch((error) => {
      // A configuration that cannot be repaired is reported, not hidden: readiness will
      // still describe the provider as unconfigured, which is the honest answer.
      console.warn('[Secure Workspaces] Could not reconcile plugin registration:', safeErrorMessage(error, 'reconciliation failed'));
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

  /**
   * Who may ask for a privileged workspace operation. This is the authorization: a host UI
   * session or a client holding the capability, and never a request arriving over a tunnel.
   *
   * It deliberately does not ask for the password again. Nothing that this feature exists
   * to contain can reach these endpoints: the workspace network is created `--internal`,
   * so the runtime has no route to the host at all, and a tunnel request is refused above
   * regardless of credentials. What remained was a prompt that a person answered on their
   * own machine, in front of a screen listing exactly what they had asked for — and asked
   * often enough that it stopped being read, which costs more than it defends. Changing
   * the policy itself still asks; see {@link authorizePolicyChange}.
   */
  async function authorizeAdminRequest(req, res, capability) {
    if (!requireSupportedBoundary(res)) return false;
    if (!uiAuthController?.resolveAuthContext) {
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
    return true;
  }

  /**
   * The same authorization, plus a single-use proof bound to the exact submitted body.
   *
   * Reserved for changing the Secure Workspace policy, which is the one operation that
   * operates on the protections rather than within them: it can widen the egress
   * allowlist, change the runtime image, or switch the feature off. Every other action
   * shows what it will do before doing it — this one takes effect quietly and stays in
   * effect, so it is worth the interruption.
   */
  async function authorizePolicyChange(req, res, capability, operation, project, payload) {
    if (!await authorizeAdminRequest(req, res, capability)) return false;
    if (!uiAuthController?.consumeReauthProof) {
      res.status(500).json({ error: 'Workspace authorization is unavailable' });
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

  /** The authoritative row for a create OpenCode gave up waiting on, if one exists. */
  async function findAuthoritativeRow(client, id, directory) {
    try {
      const list = await client.experimental.workspace.list({ directory });
      if (list?.error || !Array.isArray(list?.data)) return null;
      return list.data.find((item) => item?.id === id) ?? null;
    } catch {
      return null;
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
        // `disconnected` is not terminal here: OpenCode sets it at sync start, before the
        // connect loop has tried anything, so every booting workspace passes through it
        // by design. Treating it as an answer destroyed healthy Kubernetes workspaces
        // whose port-forward was still coming up. Only an explicit error ends the wait.
        if (current?.status === 'error') return { status: current.status, diagnostics };
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
    if (!await authorizeAdminRequest(req, res, 'workspace.admin')) return;
    if (!SECURE_WORKSPACE_PROVIDERS.has(provider)) return res.status(400).json({ available: false, error: 'Unsupported workspace provider' });
    try {
      const context = await persistedContext('', null);
      return res.json(await (await operationsFor(context)).validateProvider(provider));
    } catch (error) {
      return res.status(error?.statusCode || 503).json({ available: false, error: safeErrorMessage(error, 'Workspace provider is unavailable'), code: typeof error?.code === 'string' ? error.code : undefined });
    }
  }
  app.get('/api/workspaces/providers/validate', handleProviderValidation);
  app.post('/api/workspaces/providers/validate', handleProviderValidation);

  // Reading which clusters the host already knows is not a host change, so it carries the
  // same capability check as readiness rather than a step-up prompt for a list of names.
  app.get('/api/workspaces/providers/environment', async (req, res) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : '';
    if (!await authorizeCapabilityRequest(req, res, 'workspace.read', { allowUnsupported: true })) return;
    if (!SECURE_WORKSPACE_PROVIDERS.has(provider)) return res.status(400).json({ error: 'Unsupported workspace provider' });
    try {
      const context = await persistedContext('', null);
      return res.json(await (await operationsFor(context)).describeProvider(provider));
    } catch {
      // A host that cannot describe its clusters is not an error state: it simply has none
      // to offer, and the operator can still name one by hand.
      return res.json({ provider, contexts: [], currentContext: null });
    }
  });

  /**
   * Which listed workspaces were created under settings that are no longer in force.
   * The answer is in each workspace's own metadata, so it can be shown beside the
   * workspace rather than discovered by attempting an operation and having it refused.
   * The comparison folds in each workspace's own image, so it cannot be done by
   * comparing one fingerprint in the browser.
   */
  app.get('/api/workspaces/policy-state', async (req, res) => {
    if (!await authorizeCapabilityRequest(req, res, 'workspace.read', { allowUnsupported: true })) return;
    const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
    try {
      const context = await persistedContext(directory, null);
      const operations = await operationsFor(context);
      const client = await sdkClient(directory);
      const listed = await client.experimental.workspace.list(directory ? { directory } : undefined);
      const workspaces = Array.isArray(listed?.data) ? listed.data : [];
      const mismatched = [];
      for (const workspace of workspaces) {
        if (!SECURE_WORKSPACE_PROVIDERS.has(workspace?.type)) continue;
        try {
          const state = await operations.describeWorkspacePolicyState(workspace);
          if (state?.matchesPolicy === false) mismatched.push(workspace.id);
        } catch {
          // A workspace this host cannot read is not evidence of drift, so it is not flagged.
        }
      }
      return res.json({ mismatched });
    } catch {
      // Not knowing is reported as nothing to flag: a wrong badge is worse than none.
      return res.json({ mismatched: [] });
    }
  });

  const SETUP_ACTIONS = new Set(['create-namespace', 'check-isolation']);

  // Setup actions change the cluster, so they carry the same proof as other host-affecting
  // work rather than riding on an unauthenticated readiness read.
  app.post('/api/workspaces/providers/setup', async (req, res) => {
    const provider = typeof req.body?.provider === 'string' ? req.body.provider : '';
    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    if (!await authorizeAdminRequest(req, res, 'workspace.admin')) return;
    if (!SECURE_WORKSPACE_PROVIDERS.has(provider)) return res.status(400).json({ error: 'Unsupported workspace provider' });
    if (!SETUP_ACTIONS.has(action)) return res.status(400).json({ error: 'Unsupported setup action' });
    try {
      const context = await persistedContext('', null);
      const result = await (await operationsFor(context)).prepareProvider(provider, action);
      return res.json({ ...result, provider });
    } catch (error) {
      return res.status(error?.statusCode || 503).json({ error: safeErrorMessage(error, 'Workspace setup step failed'), code: typeof error?.code === 'string' ? error.code : undefined });
    }
  });


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

  // Readiness answers "can this machine run a Secure Workspace, and if not, why" without
  // any privileged step-up: it returns availability codes only, never provider output,
  // credentials, or policy. Learning that a container runtime is missing must not cost
  // the user a password — that is a fact about their machine, not a privileged action.
  app.get('/api/workspaces/readiness', async (req, res) => {
    if (!await authorizeCapabilityRequest(req, res, 'workspace.read', { allowUnsupported: true })) return;
    try {
      await settingsRecoveryPromise;
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      const pluginSpec = workspacePluginSpec ?? (() => { try { return resolvePluginSpec(); } catch { return null; } })();
      const entries = listPluginEntries(null);
      const configuredEntry = entries.find((entry) => isWorkspacePluginEntry(entry, pluginSpec)) ?? entries.find((entry) => isWorkspacePluginEntry(entry, null));
      const boundary = getWorkspaceRuntimeBoundary();
      const adapterProbe = boundary?.supported === false ? { ok: false, status: 501, adapters: [], error: boundary.error } : await probeWorkspaceAdapters(directory);
      const compatibility = createCompatibilityResult({ configured: Boolean(configuredEntry), spec: configuredEntry?.spec ?? pluginSpec ?? undefined, adapterProbe, boundary });

      let settings = null;
      let operations = null;
      let policyError;
      try {
        const context = await persistedContext(directory, null);
        settings = context.settings;
        operations = await operationsFor(context);
      } catch (error) {
        policyError = safeErrorMessage(error, 'Secure Workspace policy is incomplete');
      }

      const providers = await Promise.all(compatibility.platformProviders.map(async (provider) => {
        if (!operations) {
          const verdict = { available: false, code: 'WORKSPACE_POLICY_INCOMPLETE' };
          return { provider, ...verdict, steps: workspaceSetupSteps(provider, verdict) };
        }
        try {
          const result = await operations.validateProvider(provider);
          const verdict = { available: result?.available === true };
          return { provider, ...verdict, diagnostics: result?.diagnostics ?? [], steps: workspaceSetupSteps(provider, verdict, isolationVerdict(result)) };
        } catch (error) {
          const verdict = { available: false, code: typeof error?.code === 'string' ? error.code : 'WORKSPACE_PROVIDER_UNAVAILABLE' };
          return { provider, ...verdict, steps: workspaceSetupSteps(provider, verdict) };
        }
      }));

      return res.json({
        ...compatibility,
        enabled: settings?.enabled === true,
        defaultProvider: settings?.defaultProvider ?? 'docker',
        providers,
        ...(policyError ? { policyError } : {}),
      });
    } catch (error) {
      return res.status(500).json({ error: safeErrorMessage(error, 'Failed to inspect workspace readiness') });
    }
  });

  const handleWorkspaceCreate = async (req, res) => {
    const directorySource = typeof req.body?.directory === 'string' ? req.body.directory : req.query?.directory;
    const directory = typeof directorySource === 'string' ? directorySource.trim() : '';
    const type = typeof req.body?.type === 'string' ? req.body.type : '';
    const extra = req.body?.extra && typeof req.body.extra === 'object' && !Array.isArray(req.body.extra) ? req.body.extra : null;
    const payload = { type, directory, extra };
    if (!await authorizeAdminRequest(req, res, 'workspace.admin')) return;
    if (!SECURE_WORKSPACE_PROVIDERS.has(type)) return res.status(400).json({ error: 'Unsupported workspace provider' });
    let context;
    let client;
    const provisionalID = randomWorkspaceID();
    try {
      context = await persistedContext(directory, null);
      buildPluginOptions(context.settings, { requireComplete: true });
      client = await sdkClient(context.directory);
      const result = await client.experimental.workspace.create({ id: provisionalID, type, directory: context.directory, branch: null, extra: { image: context.settings.image } });
      if (result?.error || !result?.data) throw new Error(safeErrorMessage(result?.error, result?.response?.statusText || 'Failed to create workspace'));
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
      // OpenCode's own post-create wait is a few seconds and reports the missed window
      // as a create failure while the containers it just started are still booting.
      // Before compensating — which destroys a healthy workspace — ask authoritative
      // status with a wait sized to how long creation actually takes, and give the
      // same answers the successful-create path gives for the same evidence.
      if (isUpstreamCreateWaitTimeout(originalError)) {
        const row = await findAuthoritativeRow(client, provisionalID, context.directory);
        if (row) {
          const connection = await waitForWorkspaceConnection(client, provisionalID, context.directory);
          if (connection.status === 'connected') {
            return res.status(201).json({ ...row, status: 'connected', provisional: false, retryable: false, diagnostics: [...connection.diagnostics, `OpenCode stopped waiting before workspace ${provisionalID} connected; authoritative status confirmed the connection`] });
          }
          if (connection.status === 'timeout') {
            return res.status(202).json({ ...row, status: 'connecting', provisional: true, retryable: true, diagnostics: [...connection.diagnostics, `Workspace ${provisionalID} is still provisional; retry authoritative status before use`] });
          }
        }
      }
      const compensation = await compensateCreate({ id: provisionalID, context, client });
      return res.status(error?.statusCode || 409).json({ error: originalError, provisionalID, retryable: compensation.retryable, compensation, remainingResources: compensation.remainingResources, diagnostics: [...(Array.isArray(error?.diagnostics) ? error.diagnostics : []), ...compensation.diagnostics] });
    }
  };
  app.post('/api/workspaces/create', handleWorkspaceCreate);
  app.post('/api/experimental/workspace', handleWorkspaceCreate);

  /**
   * Creating a session routed into a workspace is intercepted ahead of the generic
   * proxy so the server can record which workspace the session went to, and from which
   * host project. OpenCode keeps that association in its own database but exposes it on
   * no read path — scoped lists exclude routed sessions, the `workspace` list filter is
   * ignored, and session reads omit `workspaceID` — so without this record a client
   * that did not create the session (or was restarted since) has nothing to group it
   * by. A create without an explicit workspace falls through to the proxy untouched.
   * Authorization mirrors the proxy's rule for workspace-explicit calls: a host UI
   * session, or a client principal holding `workspace.use`.
   */
  app.post('/api/session', async (req, res, next) => {
    const explicit = [req.query?.workspace, req.query?.workspaceID, req.body?.workspace, req.body?.workspaceID]
      .find((value) => typeof value === 'string' && value.trim());
    const workspaceID = typeof explicit === 'string' ? explicit.trim() : '';
    if (!workspaceID) return next();
    const directorySource = typeof req.query?.directory === 'string' ? req.query.directory : req.body?.directory;
    const directory = typeof directorySource === 'string' ? directorySource.trim() : '';
    const authorization = await authorizeCapabilityRequest(req, res, 'workspace.use');
    if (!authorization) return;
    try {
      const client = await sdkClient(directory || undefined);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const created = await client.session.create({ ...body, ...(directory ? { directory } : {}), workspace: workspaceID });
      if (created?.error || !created?.data?.id) {
        const status = created?.response?.status && created.response.status >= 400 ? created.response.status : 502;
        return res.status(status).json(created?.error ?? { error: 'Failed to create workspace session' });
      }
      if (directory) {
        await sessionRouteStore.record({ sessionID: created.data.id, workspaceID, projectDirectory: directory }).catch((error) => {
          console.warn(`[Secure Workspaces] Session route for ${created.data.id} could not be recorded: ${safeErrorMessage(error, 'unknown failure')}`);
        });
      }
      return res.status(created.response?.status === 201 ? 201 : 200).json(created.data);
    } catch (error) {
      return res.status(error?.statusCode || 502).json({ error: safeErrorMessage(error, 'Failed to create workspace session') });
    }
  });

  /** Recorded session↔workspace↔project routes; the read is capability-only like readiness. */
  app.get('/api/workspaces/session-routes', async (req, res) => {
    if (!await authorizeCapabilityRequest(req, res, 'workspace.read', { allowUnsupported: true })) return;
    try {
      return res.json({ routes: await sessionRouteStore.routes() });
    } catch (error) {
      return res.status(500).json({ error: safeErrorMessage(error, 'Failed to read workspace session routes') });
    }
  });

  app.post('/api/workspaces/sessions/start', async (req, res) => {
    const operationID = typeof req.body?.operationID === 'string' ? req.body.operationID : '';
    const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : '';
    const authorization = await authorizeCapabilityRequest(req, res, 'workspace.use');
    if (!authorization) return;
    try {
      const context = await persistedContext(directory, null);
      const provider = context.settings.defaultProvider;
      const payload = { operationID, directory, title };
      const result = await startOrdinaryWorkspaceSession({ operationID, principal: authorization.principal, directory: context.directory, projectID: context.project.id, title, provider, client: await sdkClient(context.directory), journal: ordinarySessionJournal, maxAttempts: workspaceCreateStatusMaxAttempts, pollIntervalMs: workspaceCreateStatusPollIntervalMs, compensateCreate: async (provisionalID) => compensateCreate({ id: provisionalID, context, client: await sdkClient(context.directory) }), authorizeCreation: async () => {
        const capabilities = Array.isArray(authorization.context?.client?.capabilities) ? authorization.context.client.capabilities : [];
        // Creating a workspace from chat is the same operation as creating one from the
        // panel, and asks for the same thing: the capability, not a second credential.
        // Prompting here and not there would be the worse of both answers.
        if (authorization.context?.type !== 'session' && !capabilities.includes('workspace.admin')) throw Object.assign(new Error('Client capability required: workspace.admin'), { statusCode: 403, code: 'WORKSPACE_SESSION_UNAUTHORIZED' });
        return true;
      } });
      if (result.sessionID && result.workspaceID) {
        await sessionRouteStore.record({ sessionID: result.sessionID, workspaceID: result.workspaceID, projectDirectory: context.directory }).catch((recordError) => {
          console.warn(`[Secure Workspaces] Session route for ${result.sessionID} could not be recorded: ${safeErrorMessage(recordError, 'unknown failure')}`);
        });
      }
      return res.status(result.status === 'completed' ? 201 : 202).json(result);
    } catch (error) {
      const message = safeErrorMessage(error, 'Failed to start workspace session');
      const code = error?.code || 'WORKSPACE_SESSION_START_FAILED';
      if (code !== 'WORKSPACE_SESSION_REAUTH_REQUIRED') {
        console.error(`[Secure Workspaces] Session start failed for operation ${operationID} (${code}): ${message}`);
      }
      return res.status(error?.statusCode || 409).json({ code, message, retryable: error?.retryable === true || error?.statusCode === 428, operationID, ...(error?.workspaceID ? { workspaceID: error.workspaceID } : {}), ...(error?.sessionID ? { sessionID: error.sessionID } : {}) });
    }
  });

  const handleWorkspaceCleanup = async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id : '';
    const directorySource = typeof req.body?.directory === 'string' ? req.body.directory : req.query?.directory;
    const directory = typeof directorySource === 'string' ? directorySource.trim() : '';
    const payload = { id, directory };
    if (!await authorizeAdminRequest(req, res, 'workspace.admin')) return;
    try {
      let workspace = await loadOpenCodeWorkspace({ id, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders, createClient: createOpenCodeClient });
      const context = await persistedContext(directory, workspace);
      const operations = await operationsFor(context);
      workspace = verifiedCleanupWorkspace(workspace);
      const cleanup = await operations.cleanupWorkspace(workspace);
      const remainingResources = Array.isArray(cleanup?.remainingResources) ? cleanup.remainingResources.filter((item) => typeof item === 'string') : [];
      const retainedResources = Array.isArray(cleanup?.retainedResources) ? cleanup.retainedResources.filter((item) => typeof item === 'string') : [];
      const diagnostics = Array.isArray(cleanup?.diagnostics) ? cleanup.diagnostics.filter((item) => typeof item === 'string') : [];
      if (cleanup?.ok !== true || remainingResources.length > 0) {
        console.error(`[Secure Workspaces] Cleanup incomplete for workspace ${id}: remaining ${remainingResources.join(', ') || 'unknown'}`);
        return res.status(409).json({ cleaned: false, retryable: true, error: 'Workspace provider cleanup is incomplete', remainingResources, retainedResources, diagnostics });
      }
      const result = await (await sdkClient(context.directory)).experimental.workspace.remove({ id, directory: context.directory });
      if (result?.error || !result?.data) throw new Error('Provider cleanup succeeded, but the OpenCode workspace record could not be removed');
      console.log(`[Secure Workspaces] Cleanup completed for workspace ${id}${retainedResources.length > 0 ? ` (retained: ${retainedResources.join(', ')})` : ''}`);
      return res.json({ cleaned: true, workspace: result.data, diagnostics, retainedResources });
    } catch (error) {
      const message = safeErrorMessage(error, 'Failed to clean up workspace');
      console.error(`[Secure Workspaces] Cleanup failed for workspace ${id}${typeof error?.code === 'string' ? ` (${error.code})` : ''}: ${message}`);
      return res.status(error?.statusCode || 409).json({ cleaned: false, retryable: true, error: message, code: typeof error?.code === 'string' ? error.code : undefined, remainingResources: Array.isArray(error?.remainingResources) ? error.remainingResources : [] });
    }
  };
  app.delete('/api/workspaces/:id', handleWorkspaceCleanup);
  app.delete('/api/experimental/workspace/:id', handleWorkspaceCleanup);

  app.post('/api/workspaces/:id/reconcile', async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id : '';
    const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
    const payload = { id, directory };
    if (!await authorizeAdminRequest(req, res, 'workspace.admin')) return;
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
    if (!await authorizeAdminRequest(req, res, 'workspace.admin')) return;
    try {
      let workspace = await loadOpenCodeWorkspace({ id: req.params.id, directory: requestedDirectory, buildOpenCodeUrl, getOpenCodeAuthHeaders, createClient: createOpenCodeClient });
      const context = await persistedContext(requestedDirectory, workspace);
      const operations = await operationsFor(context);
      workspace = await verifiedAuthoritativeWorkspace(workspace, operations);
      const identity = authoritativeIdentity(workspace);
      const rawArtifact = await operations.exportWorkspace(workspace);
      const parsed = parseWorkspaceArtifact(rawArtifact, { ...identity, targetDirectory: context.directory });
      const review = await createArtifactReview(parsed, { directory: context.directory });
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
    if (!await authorizeAdminRequest(req, res, 'host.apply')) return;
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
    if (!await authorizePolicyChange(req, res, 'workspace.admin', 'workspace.configure', 'host', proofBinding)) return;

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
