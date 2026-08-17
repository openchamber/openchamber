import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { WORKSPACE_PLUGIN_PACKAGE } from './plugin-identity.js';

/**
 * Authoritative workspace identity, redaction, and the small primitives the route layer
 * shares with it. Nothing here reads request state or closes over injected dependencies:
 * a workspace record either proves its own identity or it does not, and that judgement
 * must be the same wherever it is made.
 */

export const SECURE_WORKSPACE_PROVIDERS = new Set(['docker', 'kubernetes', 'apple-container']);

export async function loadWorkspaceOperationsFactory() {
  try {
    const operationsSpecifier = `${WORKSPACE_PLUGIN_PACKAGE}/operations`;
    const module = await import(/* @vite-ignore */ operationsSpecifier);
    if (typeof module.createWorkspaceProviderOperations !== 'function') throw new Error('operations factory is missing');
    return module.createWorkspaceProviderOperations;
  } catch (error) {
    throw Object.assign(new Error(`Secure workspace provider operations are unavailable in the pinned plugin package: ${safeErrorMessage(error, 'incompatible package')}`), { statusCode: 503 });
  }
}

/** An error message safe to return to a caller: never a token, however it was spelled. */
export function safeErrorMessage(error, fallback) {
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

export function reauthBodyHash(payload) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

export async function atomicWritePrivateJson(file, value) {
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
export function isolationVerdict(result) {
  const verdict = result?.isolation?.verdict;
  return ISOLATION_VERDICTS.has(verdict) ? { verdict } : null;
}

export function platformProviders() {
  const providers = ['docker', 'kubernetes'];
  if (process.platform === 'darwin') providers.push('apple-container');
  return providers;
}

export function createCompatibilityResult({ configured, spec, adapterProbe, boundary }) {
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

export async function loadOpenCodeWorkspace({ id, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders, createClient = createOpencodeClient }) {
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

export function authoritativeIdentity(workspace) {
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

export function recoverableIdentityMismatch(workspace) {
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

export async function verifiedAuthoritativeWorkspace(workspace, operations) {
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

/**
 * Cleanup verification tolerates a control-plane ID drift without requiring a healthy
 * adoption: a degraded workspace must remain deletable, and the identity drift is
 * resolved by the plugin operations layer against persisted provider state.
 */
export function verifiedCleanupWorkspace(workspace) {
  try {
    authoritativeIdentity(workspace);
    return workspace;
  } catch (error) {
    if (!recoverableIdentityMismatch(workspace)) throw error;
    return workspace;
  }
}
