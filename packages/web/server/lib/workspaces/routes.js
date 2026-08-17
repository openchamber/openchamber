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
import { createWorkspaceAuthorization } from './authorization.js';
import { createSettingsTransaction } from './settings-transaction.js';
import {
  SECURE_WORKSPACE_PROVIDERS,
  atomicWritePrivateJson,
  authoritativeIdentity,
  createCompatibilityResult,
  isolationVerdict,
  loadOpenCodeWorkspace,
  loadWorkspaceOperationsFactory,
  platformProviders,
  reauthBodyHash,
  safeErrorMessage,
  verifiedAuthoritativeWorkspace,
  verifiedCleanupWorkspace,
} from './identity.js';

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
  let settingsMutationQueue = Promise.resolve();
  const resolvedWorkspacePluginSpec = () => workspacePluginSpec ?? resolvePluginSpec();
  const {
    settingsTransactionFile,
    settingsRecoveryPromise,
    workspacePluginEntries,
    restoreWorkspaceConfiguration,
    clearSettingsTransaction,
  } = createSettingsTransaction({
    openchamberDataDir,
    readSettingsFromDiskMigrated,
    restoreSettingsFields,
    listPluginEntries,
    createPluginEntry,
    deletePluginEntry,
    resolvedWorkspacePluginSpec,
  });

  const { principalFor, requireSupportedBoundary, authorizeAdminRequest, authorizePolicyChange, authorizeCapabilityRequest } =
    createWorkspaceAuthorization({ uiAuthController, tunnelAuthController, getWorkspaceRuntimeBoundary });

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
