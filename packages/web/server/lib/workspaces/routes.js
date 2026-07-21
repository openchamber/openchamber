import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalWorkspaceLabelID } from '@openchamber/opencode-container-workspace/label-id';
import { SECURE_APPLE_CONTAINER_NETWORK, SECURE_DOCKER_NETWORK } from '@openchamber/opencode-container-workspace/policy';
import { buildPatchFromSectionIDs, parseWorkspacePatchSections, summarizePatchSections } from './patch-sections.js';

const MAX_PATCH_BYTES = 20 * 1024 * 1024;
const EXPORT_ARTIFACT_TTL_MS = 30 * 60 * 1000;
const EXPORT_ARTIFACT_MAX_COUNT = 20;
const EXPORT_ARTIFACT_MAX_BYTES = 80 * 1024 * 1024;
const WORKSPACE_ADAPTER_PROBE_TIMEOUT_MS = 10_000;
const WORKSPACE_PLUGIN_PACKAGE = '@openchamber/opencode-container-workspace';
const WORKSPACE_PLUGIN_RESOURCE_PATH = path.join('opencode-container-workspace', 'src', 'plugin.js');
const EXPORT_DIFF_COMMAND = 'tmp=$(mktemp); idx=$(git rev-parse --git-path index 2>/dev/null || true); if [ -n "$idx" ] && [ -f "$idx" ]; then cp "$idx" "$tmp"; fi; GIT_INDEX_FILE="$tmp" git add -N . >/dev/null 2>&1 || true; GIT_INDEX_FILE="$tmp" git diff --binary HEAD; code=$?; rm -f "$tmp"; exit $code';
const SECURE_WORKSPACE_PROVIDERS = new Set(['docker', 'kubernetes', 'apple-container']);

export function resolveWorkspacePluginSpec(options = {}) {
  const env = options.env ?? process.env;
  const explicit = typeof env.OPENCHAMBER_WORKSPACE_PLUGIN_PATH === 'string'
    ? env.OPENCHAMBER_WORKSPACE_PLUGIN_PATH.trim()
    : '';
  if (explicit) return explicit;

  const resolved = fileURLToPath(options.resolvedSpecUrl ?? import.meta.resolve(WORKSPACE_PLUGIN_PACKAGE));
  if (!resolved.includes('.asar')) return resolved;

  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const resourceCandidate = resourcesPath
    ? path.join(resourcesPath, WORKSPACE_PLUGIN_RESOURCE_PATH)
    : '';
  if (resourceCandidate && fs.existsSync(resourceCandidate)) return resourceCandidate;

  const unpackedCandidate = resolved.replace(/\.asar([/\\])/, '.asar.unpacked$1');
  if (unpackedCandidate !== resolved && fs.existsSync(unpackedCandidate)) return unpackedCandidate;

  throw new Error('Secure workspace plugin is inside app.asar and no unpacked plugin resource is available');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnCommand = options.spawn ?? spawn;
    const child = spawnCommand(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out`));
    }, options.timeoutMs ?? 30_000);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(stderr || stdout || `${command} failed with ${code}`);
      error.status = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function normalizePatch(value) {
  if (typeof value !== 'string') return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_PATCH_BYTES) return null;
  return value;
}

function summarizePatch(patch) {
  return summarizePatchSections(parseWorkspacePatchSections(patch));
}

class ExportArtifactCache {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.entries = new Map();
    this.totalBytes = 0;
  }

  create({ patch, provider, workspaceID, directory }) {
    this.prune();
    const patchBytes = Buffer.byteLength(patch, 'utf8');
    if (patchBytes > MAX_PATCH_BYTES) throw new Error('Patch is required and must be under 20MB');
    const sections = parseWorkspacePatchSections(patch);
    const summary = summarizePatchSections(sections);
    const id = crypto.randomBytes(18).toString('base64url');
    const entry = {
      id,
      patch,
      patchBytes,
      provider,
      workspaceID,
      directory: typeof directory === 'string' ? directory : '',
      sections,
      summary,
      createdAt: this.now(),
      expiresAt: this.now() + EXPORT_ARTIFACT_TTL_MS,
    };
    this.entries.set(id, entry);
    this.totalBytes += patchBytes;
    this.prune();
    return entry;
  }

  get(id) {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.delete(id);
      return null;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry;
  }

  delete(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.totalBytes -= entry.patchBytes;
  }

  prune() {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(id);
    }
    while (this.entries.size > EXPORT_ARTIFACT_MAX_COUNT || this.totalBytes > EXPORT_ARTIFACT_MAX_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.delete(oldest);
    }
  }
}

function createCompatibilityResult({ configured, spec, adapterProbe }) {
  const adapterKinds = adapterProbe.adapters.map((adapter) => adapter?.kind ?? adapter?.id ?? adapter?.type).filter(Boolean);
  const active = adapterProbe.ok && adapterKinds.some((kind) => SECURE_WORKSPACE_PROVIDERS.has(kind));
  return {
    configured,
    active,
    supported: adapterProbe.status !== 404 && adapterProbe.status !== 501,
    adapterKinds,
    spec,
    status: active ? 'active' : configured ? 'pending-activation' : 'not-configured',
    error: adapterProbe.error,
  };
}

function safeErrorMessage(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/(OPENCHAMBER_WORKSPACE_AUTH_TOKEN=)[^\s]+/g, '$1[redacted]')
    .replace(/(x-openchamber-workspace-token[:=]\s*)[^\s]+/gi, '$1[redacted]')
    .replace(/(token[:=]\s*)[A-Za-z0-9._~+/-]{16,}/gi, '$1[redacted]');
}

function readOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function validateProxyUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Workspace egress proxy URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Workspace egress proxy URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Workspace egress proxy URL must not include credentials');
  }
}

function validateCIDR(value, label) {
  const [address, prefix, extra] = String(value).split('/');
  const family = isIP(address);
  const prefixNumber = Number(prefix);
  const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
  if (extra !== undefined || !family || prefix === undefined || !Number.isInteger(prefixNumber) || prefixNumber < 0 || prefixNumber > maxPrefix) {
    throw new Error(`${label} must be a valid IPv4 or IPv6 CIDR`);
  }
}

function validateDockerEgress(settings) {
  if (!settings.egressHttpProxy) throw new Error('Docker secure workspaces require an egress HTTP proxy');
  validateProxyUrl(settings.egressHttpProxy);
}

function validateKubernetesEgress(settings) {
  if (!settings.egressHttpProxy || !settings.egressProxyCIDR || settings.egressDnsCIDRs.length === 0) {
    throw new Error('Kubernetes secure workspaces require an egress HTTP proxy, proxy CIDR, and at least one DNS CIDR');
  }
  validateProxyUrl(settings.egressHttpProxy);
  validateCIDR(settings.egressProxyCIDR, 'Workspace egress proxy CIDR');
  for (const cidr of settings.egressDnsCIDRs) validateCIDR(cidr, 'Workspace egress DNS CIDR');
}

function validateAppleContainerEgress(settings) {
  if (!settings.egressHttpProxy) throw new Error('Apple Container secure workspaces require an egress HTTP proxy');
  validateProxyUrl(settings.egressHttpProxy);
}

async function validateAppleContainer(settings, spawnCommand) {
  validateAppleContainerEgress(settings);
  const cli = process.env.OPENCHAMBER_WORKSPACE_APPLE_CONTAINER_CLI || 'container';
  await run(cli, ['system', 'status'], { timeoutMs: 15_000, spawn: spawnCommand });
  const version = await run(cli, ['--version'], { timeoutMs: 15_000, spawn: spawnCommand }).catch(() => ({ stdout: '' }));
  return { available: true, version: version.stdout.trim() || null };
}

async function validateDocker(settings, spawnCommand) {
  validateDockerEgress(settings);
  await run('docker', ['info'], { timeoutMs: 15_000, spawn: spawnCommand });
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000, spawn: spawnCommand }).catch(() => ({ stdout: '' }));
  return { available: true, version: version.stdout.trim() || null };
}

async function validateKubernetes({ context, namespace }, settings, spawnCommand) {
  validateKubernetesEgress(settings);
  const base = context ? ['--context', context] : [];
  const targetNamespace = namespace || 'default';
  await run('kubectl', [...base, 'version', '--client=true'], { timeoutMs: 15_000, spawn: spawnCommand });
  for (const [verb, resource] of requiredKubernetesPermissions()) {
    const { stdout } = await run('kubectl', [...base, 'auth', 'can-i', verb, resource, '-n', targetNamespace], { timeoutMs: 15_000, spawn: spawnCommand });
    if (stdout.trim() !== 'yes') throw new Error(`Kubernetes RBAC denies ${verb} ${resource} in namespace ${targetNamespace}`);
  }
  return { available: true, context: context || null, namespace: targetNamespace };
}

function requiredKubernetesPermissions() {
  return [
    ['get', 'pods'],
    ['list', 'pods'],
    ['watch', 'pods'],
    ['create', 'pods/exec'],
    ['create', 'pods/portforward'],
    ['create', 'secrets'],
    ['get', 'secrets'],
    ['patch', 'secrets'],
    ['delete', 'secrets'],
    ['create', 'persistentvolumeclaims'],
    ['get', 'persistentvolumeclaims'],
    ['patch', 'persistentvolumeclaims'],
    ['delete', 'persistentvolumeclaims'],
    ['create', 'deployments.apps'],
    ['get', 'deployments.apps'],
    ['patch', 'deployments.apps'],
    ['delete', 'deployments.apps'],
    ['create', 'services'],
    ['get', 'services'],
    ['patch', 'services'],
    ['delete', 'services'],
    ['create', 'networkpolicies.networking.k8s.io'],
    ['get', 'networkpolicies.networking.k8s.io'],
    ['patch', 'networkpolicies.networking.k8s.io'],
    ['delete', 'networkpolicies.networking.k8s.io'],
  ];
}

function readWorkspaceSettings(settings) {
  const defaultProvider = settings?.secureWorkspacesDefaultProvider === 'kubernetes'
    ? 'kubernetes'
    : settings?.secureWorkspacesDefaultProvider === 'apple-container'
      ? 'apple-container'
      : 'docker';
  return {
    enabled: settings?.secureWorkspacesEnabled === true,
    defaultProvider,
    image: typeof settings?.secureWorkspacesImage === 'string' && settings.secureWorkspacesImage.trim()
      ? settings.secureWorkspacesImage.trim()
      : 'ghcr.io/openchamber/opencode-workspace:1.0.0',
    requirePinnedImage: settings?.secureWorkspacesRequirePinnedImage !== false,
    kubernetesContext: typeof settings?.secureWorkspacesKubernetesContext === 'string' ? settings.secureWorkspacesKubernetesContext.trim() : '',
    kubernetesNamespace: typeof settings?.secureWorkspacesKubernetesNamespace === 'string' && settings.secureWorkspacesKubernetesNamespace.trim()
      ? settings.secureWorkspacesKubernetesNamespace.trim()
      : 'openchamber-workspaces',
    egressHttpProxy: readOptionalString(settings?.secureWorkspacesEgressHttpProxy),
    egressProxyCIDR: readOptionalString(settings?.secureWorkspacesEgressProxyCIDR),
    egressDnsCIDRs: readList(settings?.secureWorkspacesEgressDnsCIDRs),
    egressNoProxy: readOptionalString(settings?.secureWorkspacesEgressNoProxy),
  };
}

function buildPluginOptions(settings) {
  return {
    defaultImage: settings.image,
    allowedImages: [settings.image],
    requirePinnedImage: settings.requirePinnedImage,
    defaultProvider: settings.defaultProvider,
    kubernetes: {
      context: settings.kubernetesContext || undefined,
      namespace: settings.kubernetesNamespace,
      networkPolicy: 'default-deny',
    },
    docker: {
      networkMode: SECURE_DOCKER_NETWORK,
      allowedNetworks: [],
    },
    appleContainer: {
      networkMode: SECURE_APPLE_CONTAINER_NETWORK,
    },
    egress: {
      httpProxy: settings.egressHttpProxy,
      proxyCIDR: settings.egressProxyCIDR,
      dnsCIDRs: settings.egressDnsCIDRs,
      noProxy: settings.egressNoProxy,
    },
  };
}

function isWorkspacePluginEntry(entry, pluginSpec) {
  return (Boolean(pluginSpec) && entry?.spec === pluginSpec)
    || entry?.spec === WORKSPACE_PLUGIN_PACKAGE
    || (typeof entry?.spec === 'string' && (
      entry.spec.includes('opencode-container-workspace')
    ));
}

async function loadOpenCodeWorkspace({ id, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders }) {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await fetch(buildOpenCodeUrl(`/experimental/workspace${query}`, ''), {
    headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
  });
  if (!response.ok) {
    throw new Error(`Failed to list OpenCode workspaces: ${response.statusText}`);
  }
  const workspaces = await response.json();
  if (!Array.isArray(workspaces)) throw new Error('OpenCode returned an invalid workspace list');
  const workspace = workspaces.find((item) => item?.id === id);
  if (!workspace) throw new Error('Workspace not found');
  return workspace;
}

function readWorkspaceExtra(workspace) {
  const extra = workspace?.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new Error('Workspace is missing provider metadata');
  }
  return extra;
}

async function exportWorkspaceDiff(workspace, spawnCommand) {
  const extra = readWorkspaceExtra(workspace);
  if (extra.provider === 'docker') {
    const container = extra.runtime?.container;
    if (!container) throw new Error('Docker workspace metadata is missing container name');
    await verifyDockerWorkspace(workspace, extra, spawnCommand);
    const { stdout } = await run('docker', ['exec', container, 'sh', '-lc', EXPORT_DIFF_COMMAND], { timeoutMs: 60_000, spawn: spawnCommand });
    return { patch: stdout, provider: 'docker' };
  }
  if (extra.provider === 'kubernetes') {
    const deployment = extra.runtime?.deployment;
    const namespace = extra.runtime?.namespace;
    if (!deployment || !namespace) throw new Error('Kubernetes workspace metadata is missing deployment or namespace');
    const contextArgs = extra.policy?.kubernetes?.context ? ['--context', extra.policy.kubernetes.context] : [];
    await verifyKubernetesWorkspace(workspace, extra, contextArgs, spawnCommand);
    const { stdout } = await run('kubectl', [
      ...contextArgs,
      'exec', `deployment/${deployment}`, '-n', namespace, '--', 'sh', '-lc', EXPORT_DIFF_COMMAND,
    ], { timeoutMs: 60_000, spawn: spawnCommand });
    return { patch: stdout, provider: 'kubernetes' };
  }
  if (extra.provider === 'apple-container') {
    const container = extra.runtime?.container;
    if (!container) throw new Error('Apple Container workspace metadata is missing container name');
    await verifyAppleContainerWorkspace(workspace, extra, spawnCommand);
    const cli = extra.policy?.appleContainer?.cli || process.env.OPENCHAMBER_WORKSPACE_APPLE_CONTAINER_CLI || 'container';
    const { stdout } = await run(cli, ['exec', container, 'sh', '-lc', EXPORT_DIFF_COMMAND], { timeoutMs: 60_000, spawn: spawnCommand });
    return { patch: stdout, provider: 'apple-container' };
  }
  throw new Error(`Unsupported workspace provider: ${extra.provider ?? '<unknown>'}`);
}

async function verifyDockerWorkspace(workspace, extra, spawnCommand) {
  requireDockerManagedLabels(workspace, extra);
  const { stdout } = await run('docker', ['inspect', extra.runtime.container], { timeoutMs: 20_000, spawn: spawnCommand });
  const labels = JSON.parse(stdout)?.[0]?.Config?.Labels ?? {};
  for (const [key, value] of Object.entries(extra.labels ?? {})) {
    if (labels[key] !== String(value)) throw new Error(`Docker workspace label mismatch for ${key}`);
  }
}

async function verifyKubernetesWorkspace(workspace, extra, contextArgs, spawnCommand) {
  requireKubernetesManagedLabels(workspace, extra);
  const { stdout } = await run('kubectl', [
    ...contextArgs,
    'get', 'deployment', extra.runtime.deployment, '-n', extra.runtime.namespace, '-o', 'json',
  ], { timeoutMs: 20_000, spawn: spawnCommand });
  const labels = JSON.parse(stdout)?.metadata?.labels ?? {};
  for (const [key, value] of Object.entries(extra.labels ?? {})) {
    if (labels[key] !== String(value)) throw new Error(`Kubernetes workspace label mismatch for ${key}`);
  }
}

async function verifyAppleContainerWorkspace(workspace, extra, spawnCommand) {
  requireAppleContainerManagedLabels(workspace, extra);
  const cli = extra.policy?.appleContainer?.cli || process.env.OPENCHAMBER_WORKSPACE_APPLE_CONTAINER_CLI || 'container';
  const { stdout } = await run(cli, ['inspect', extra.runtime.container], { timeoutMs: 20_000, spawn: spawnCommand });
  const labels = JSON.parse(stdout)?.[0]?.configuration?.labels ?? {};
  for (const [key, value] of Object.entries(extra.labels ?? {})) {
    if (labels[key] !== String(value)) throw new Error(`Apple Container workspace label mismatch for ${key}`);
  }
}

function requireDockerManagedLabels(workspace, extra) {
  const labels = extra.labels ?? {};
  const required = {
    'openchamber.managed': 'true',
    'openchamber.workspace.provider': 'docker',
    'openchamber.workspace.id': canonicalWorkspaceLabelID(workspace.id),
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value || labels[key] !== String(value)) throw new Error(`Docker workspace metadata is missing required managed label: ${key}`);
  }
}

function requireKubernetesManagedLabels(workspace, extra) {
  const labels = extra.labels ?? {};
  const required = {
    'openchamber.io/managed': 'true',
    'openchamber.io/provider': 'kubernetes',
    'openchamber.io/workspace-id': canonicalWorkspaceLabelID(workspace.id),
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value || labels[key] !== String(value)) throw new Error(`Kubernetes workspace metadata is missing required managed label: ${key}`);
  }
}

function requireAppleContainerManagedLabels(workspace, extra) {
  const labels = extra.labels ?? {};
  const required = {
    'openchamber.managed': 'true',
    'openchamber.workspace.provider': 'apple-container',
    'openchamber.workspace.id': canonicalWorkspaceLabelID(workspace.id),
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value || labels[key] !== String(value)) throw new Error(`Apple Container workspace metadata is missing required managed label: ${key}`);
  }
}

export function registerWorkspaceRoutes(app, dependencies) {
  const {
    validateDirectoryPath,
    readSettingsFromDiskMigrated,
    refreshOpenCodeAfterConfigChange,
    listPluginEntries,
    createPluginEntry,
    updatePluginEntry,
    deletePluginEntry,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    spawn: spawnCommand = spawn,
    workspacePluginSpec,
    resolveWorkspacePluginSpec: resolvePluginSpec = resolveWorkspacePluginSpec,
    exportArtifactCache = new ExportArtifactCache(),
  } = dependencies;

  async function probeWorkspaceAdapters(directory = '') {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    try {
      const response = await fetch(buildOpenCodeUrl(`/experimental/workspace/adapter${query}`, ''), {
        headers: { Accept: 'application/json', Connection: 'close', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(WORKSPACE_ADAPTER_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, status: response.status, adapters: [], error: response.statusText };
      }
      const adapters = await response.json().catch(() => []);
      return { ok: true, status: response.status, adapters: Array.isArray(adapters) ? adapters : [], error: null };
    } catch (error) {
      return { ok: false, status: 0, adapters: [], error: safeErrorMessage(error, 'Failed to probe workspace adapters') };
    }
  }

  function getConfiguredWorkspaceEntry(entries, pluginSpec) {
    return entries.find((entry) => isWorkspacePluginEntry(entry, pluginSpec))
      ?? entries.find((entry) => isWorkspacePluginEntry(entry, null));
  }

  async function handleProviderValidation(req, res) {
    const source = req.method === 'POST' ? req.body ?? {} : req.query ?? {};
    const provider = typeof source.provider === 'string' ? source.provider : '';
    try {
      const overrides = {
        ...(typeof source.context === 'string' ? { secureWorkspacesKubernetesContext: source.context } : {}),
        ...(typeof source.namespace === 'string' ? { secureWorkspacesKubernetesNamespace: source.namespace } : {}),
        ...(typeof source.egressHttpProxy === 'string' ? { secureWorkspacesEgressHttpProxy: source.egressHttpProxy } : {}),
        ...(typeof source.egressProxyCIDR === 'string' ? { secureWorkspacesEgressProxyCIDR: source.egressProxyCIDR } : {}),
        ...(typeof source.egressDnsCIDRs === 'string' ? { secureWorkspacesEgressDnsCIDRs: source.egressDnsCIDRs } : {}),
        ...(typeof source.egressNoProxy === 'string' ? { secureWorkspacesEgressNoProxy: source.egressNoProxy } : {}),
      };
      const settings = readWorkspaceSettings({
        ...(await readSettingsFromDiskMigrated()),
        ...overrides,
      });
      if (provider === 'docker') {
        return res.json(await validateDocker(settings, spawnCommand));
      }
      if (provider === 'kubernetes') {
        return res.json(await validateKubernetes({
          context: settings.kubernetesContext,
          namespace: settings.kubernetesNamespace,
        }, settings, spawnCommand));
      }
      if (provider === 'apple-container') {
        return res.json(await validateAppleContainer(settings, spawnCommand));
      }
      return res.status(400).json({ available: false, error: 'Unsupported workspace provider' });
    } catch (error) {
      return res.status(503).json({
        available: false,
        error: safeErrorMessage(error, 'Workspace provider is unavailable'),
      });
    }
  }

  app.get('/api/workspaces/providers/validate', handleProviderValidation);
  app.post('/api/workspaces/providers/validate', handleProviderValidation);

  app.get('/api/workspaces/compatibility', async (req, res) => {
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      const pluginSpec = workspacePluginSpec ?? (() => {
        try { return resolvePluginSpec(); } catch { return null; }
      })();
      const entries = listPluginEntries(null);
      const configuredEntry = getConfiguredWorkspaceEntry(entries, pluginSpec);
      const adapterProbe = await probeWorkspaceAdapters(directory);
      return res.json(createCompatibilityResult({
        configured: Boolean(configuredEntry),
        spec: configuredEntry?.spec ?? pluginSpec ?? undefined,
        adapterProbe,
      }));
    } catch (error) {
      return res.status(500).json({ error: safeErrorMessage(error, 'Failed to inspect workspace compatibility') });
    }
  });

  app.post('/api/workspaces/export/summary', async (req, res) => {
    const patch = normalizePatch(req.body?.patch);
    if (patch === null) return res.status(400).json({ error: 'Patch is required and must be under 20MB' });
    try {
      return res.json({ patchBytes: Buffer.byteLength(patch, 'utf8'), summary: summarizePatch(patch) });
    } catch (error) {
      return res.status(400).json({ error: safeErrorMessage(error, 'Failed to summarize workspace patch') });
    }
  });

  app.get('/api/workspaces/:id/export-diff', async (req, res) => {
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      const workspace = await loadOpenCodeWorkspace({
        id: req.params.id,
        directory,
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
      });
      const exportDirectory = directory || (typeof workspace.directory === 'string' ? workspace.directory : '');
      const exportDirectoryValidation = await validateDirectoryPath(exportDirectory);
      if (!exportDirectoryValidation.ok) {
        return res.status(400).json({ error: exportDirectoryValidation.error || 'Invalid directory' });
      }
      const result = await exportWorkspaceDiff(workspace, spawnCommand);
      const normalizedPatch = normalizePatch(result.patch);
      if (normalizedPatch === null) return res.status(400).json({ error: 'Patch is required and must be under 20MB' });
      const artifact = exportArtifactCache.create({
        patch: normalizedPatch,
        provider: result.provider,
        workspaceID: workspace.id,
        directory: exportDirectoryValidation.directory,
      });
      return res.json({
        patch: normalizedPatch,
        provider: result.provider,
        exportID: artifact.id,
        expiresAt: new Date(artifact.expiresAt).toISOString(),
        patchBytes: artifact.patchBytes,
        summary: artifact.summary,
      });
    } catch (error) {
      return res.status(400).json({ error: safeErrorMessage(error, 'Failed to export workspace diff') });
    }
  });

  app.post('/api/workspaces/exports/:exportID/apply', async (req, res) => {
    const exportID = typeof req.params.exportID === 'string' ? req.params.exportID : '';
    const entry = exportArtifactCache.get(exportID);
    if (!entry) return res.status(410).json({ applied: false, checkOnly: req.body?.checkOnly !== false, error: 'Workspace patch export expired; re-export required' });
    const fileIDs = Array.isArray(req.body?.fileIDs) ? req.body.fileIDs.filter((id) => typeof id === 'string') : [];
    const directory = typeof req.body?.directory === 'string' ? req.body.directory : '';
    const workspaceID = typeof req.body?.workspaceID === 'string' ? req.body.workspaceID : '';
    const checkOnly = req.body?.checkOnly !== false;
    if (!workspaceID || workspaceID !== entry.workspaceID) {
      return res.status(409).json({ applied: false, checkOnly, error: 'Workspace patch export does not match the selected workspace; re-export required' });
    }
    const validation = await validateDirectoryPath(directory);
    if (!validation.ok) return res.status(400).json({ applied: false, checkOnly, error: validation.error || 'Invalid directory' });
    if (validation.directory !== entry.directory) {
      return res.status(409).json({ applied: false, checkOnly, error: 'Workspace patch export does not match the target directory; re-export required' });
    }
    try {
      const selectedPatch = buildPatchFromSectionIDs(entry.sections, fileIDs);
      const selectedSections = entry.sections.filter((section) => fileIDs.includes(section.id));
      const summary = summarizePatchSections(selectedSections);
      await run('git', ['apply', '--check', '-'], { cwd: validation.directory, input: selectedPatch, timeoutMs: 60_000, spawn: spawnCommand });
      if (!checkOnly) {
        await run('git', ['apply', '-'], { cwd: validation.directory, input: selectedPatch, timeoutMs: 60_000, spawn: spawnCommand });
      }
      return res.json({ applied: !checkOnly, checkOnly, summary });
    } catch (error) {
      const status = error?.message?.includes('Select at least') || error?.message?.includes('no longer available') ? 400 : 409;
      return res.status(status).json({
        applied: false,
        checkOnly,
        error: safeErrorMessage(error, 'Patch cannot be applied cleanly'),
      });
    }
  });

  app.post('/api/workspaces/export/apply', async (req, res) => {
    const patch = normalizePatch(req.body?.patch);
    const directory = typeof req.body?.directory === 'string' ? req.body.directory : '';
    const checkOnly = req.body?.checkOnly !== false;
    if (patch === null) return res.status(400).json({ error: 'Patch is required and must be under 20MB' });
    const validation = await validateDirectoryPath(directory);
    if (!validation.ok) return res.status(400).json({ error: validation.error || 'Invalid directory' });
    try {
      await run('git', ['apply', '--check', '-'], { cwd: validation.directory, input: patch, timeoutMs: 60_000, spawn: spawnCommand });
      if (!checkOnly) {
        await run('git', ['apply', '-'], { cwd: validation.directory, input: patch, timeoutMs: 60_000, spawn: spawnCommand });
      }
      return res.json({ applied: !checkOnly, checkOnly, summary: summarizePatch(patch) });
    } catch (error) {
      return res.status(409).json({
        applied: false,
        checkOnly,
        error: safeErrorMessage(error, 'Patch cannot be applied cleanly'),
      });
    }
  });

  app.post('/api/workspaces/configure', async (req, res) => {
    try {
      const activate = req.body?.activate === true;
      const settings = readWorkspaceSettings(await readSettingsFromDiskMigrated());
      const entries = listPluginEntries(null);
      if (!settings.enabled) {
        const existingEntries = entries.filter((entry) => isWorkspacePluginEntry(entry, null));
        for (const existing of existingEntries) {
          deletePluginEntry(existing.id, null);
        }
        if (activate && existingEntries.length > 0) {
          await refreshOpenCodeAfterConfigChange('secure workspaces disabled');
        }
        const adapterProbe = await probeWorkspaceAdapters('');
        const compatibility = createCompatibilityResult({ configured: false, spec: undefined, adapterProbe });
        return res.json({
          configured: false,
          enabled: false,
          active: compatibility.active,
          activated: activate,
          compatibility,
        });
      }

      const pluginSpec = workspacePluginSpec ?? resolvePluginSpec();
      if (settings.defaultProvider === 'docker') validateDockerEgress(settings);
      if (settings.defaultProvider === 'kubernetes') validateKubernetesEgress(settings);
      if (settings.defaultProvider === 'apple-container') validateAppleContainerEgress(settings);
      const existing = entries.find((entry) => isWorkspacePluginEntry(entry, pluginSpec));
      const entry = {
        spec: pluginSpec,
        scope: 'user',
        options: buildPluginOptions(settings),
      };
      if (existing) updatePluginEntry(existing.id, entry, null);
      else createPluginEntry(entry, null);
      let activation = { reloaded: false, external: false };
      if (activate) {
        activation = await refreshOpenCodeAfterConfigChange('secure workspaces configured');
      }
      const adapterProbe = await probeWorkspaceAdapters('');
      const compatibility = createCompatibilityResult({ configured: true, spec: pluginSpec, adapterProbe });
      return res.json({
        configured: true,
        enabled: true,
        spec: pluginSpec,
        activated: activate,
        active: compatibility.active,
        external: activation.external,
        manualRestartRequired: activate && activation.external && !compatibility.active,
        compatibility,
      });
    } catch (error) {
      console.error('[API:POST /api/workspaces/configure] Failed:', safeErrorMessage(error, 'Failed to configure secure workspaces'));
      return res.status(500).json({ error: safeErrorMessage(error, 'Failed to configure secure workspaces') });
    }
  });
}
