import type {
  WorkspaceApplyResult,
  WorkspaceArtifactDownload,
  WorkspaceCompatibilityResult,
  WorkspaceConfigureResult,
  WorkspaceExportResult,
  WorkspaceProviderKind,
  WorkspaceProviderValidationInput,
  WorkspaceProviderValidationResult,
  WorkspaceReadinessResult,
  WorkspaceSecurityAPI,
  WorkspaceProviderEnvironment,
  WorkspaceSetupResult,
  WorkspaceHandoffOperation,
  WorkspaceSessionStartError,
  WorkspaceSessionStartResult,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { requestReauthProof } from './reauth';

async function readJson<T>(response: Response, fallback: T): Promise<T> {
  return response.json().catch(() => fallback) as Promise<T>;
}

const proofHeaders = (proof?: string, nonce?: string): Record<string, string> => proof && nonce ? {
  'X-OpenChamber-Reauth-Proof': proof,
  'X-OpenChamber-Reauth-Nonce': nonce,
} : {};

export const createWebWorkspaceSecurityAPI = (): WorkspaceSecurityAPI => ({
  reauthenticate: requestReauthProof,

  async validateProvider(input: WorkspaceProviderValidationInput & { reauthProof?: string; reauthNonce?: string }): Promise<WorkspaceProviderValidationResult> {
    const response = await runtimeFetch('/api/workspaces/providers/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...proofHeaders(input.reauthProof, input.reauthNonce) },
      body: JSON.stringify(input),
    });
    const payload = await readJson<WorkspaceProviderValidationResult>(response, { available: false });
    if (!response.ok) return { ...payload, available: false, error: payload.error || response.statusText };
    return payload;
  },

  async readiness(input?: { directory?: string | null }): Promise<WorkspaceReadinessResult> {
    const response = await runtimeFetch('/api/workspaces/readiness', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      query: input?.directory ? { directory: input.directory } : {},
    });
    const payload = await readJson<WorkspaceReadinessResult | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw new Error('error' in payload && payload.error ? payload.error : 'Failed to inspect workspace readiness');
    return payload as WorkspaceReadinessResult;
  },

  async setupProvider(input: { provider: WorkspaceProviderKind; action: 'create-namespace' | 'check-isolation'; reauthProof?: string; reauthNonce?: string }): Promise<WorkspaceSetupResult> {
    const response = await runtimeFetch('/api/workspaces/providers/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...proofHeaders(input.reauthProof, input.reauthNonce) },
      body: JSON.stringify({ provider: input.provider, action: input.action }),
    });
    const payload = await readJson<WorkspaceSetupResult | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw new Error('error' in payload && payload.error ? payload.error : 'Workspace setup step failed');
    return payload as WorkspaceSetupResult;
  },

  async providerEnvironment(input: { provider: WorkspaceProviderKind }): Promise<WorkspaceProviderEnvironment> {
    const response = await runtimeFetch('/api/workspaces/providers/environment', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      query: { provider: input.provider },
    });
    const payload = await readJson<WorkspaceProviderEnvironment>(response, { provider: input.provider, contexts: [], currentContext: null });
    return response.ok ? payload : { provider: input.provider, contexts: [], currentContext: null };
  },

  async sessionRoutes(): Promise<{ routes: Array<{ sessionID: string; workspaceID: string; projectDirectory: string }> }> {
    const response = await runtimeFetch('/api/workspaces/session-routes', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await readJson<{ routes?: Array<{ sessionID?: string; workspaceID?: string; projectDirectory?: string }> }>(response, {});
    const routes = Array.isArray(payload.routes) ? payload.routes : [];
    return {
      routes: routes.filter((route): route is { sessionID: string; workspaceID: string; projectDirectory: string } => Boolean(
        route && typeof route.sessionID === 'string' && typeof route.workspaceID === 'string' && typeof route.projectDirectory === 'string',
      )),
    };
  },

  async policyState(input?: { directory?: string | null }): Promise<{ mismatched: string[] }> {
    const response = await runtimeFetch('/api/workspaces/policy-state', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      query: input?.directory ? { directory: input.directory } : {},
    });
    const payload = await readJson<{ mismatched?: string[] }>(response, {});
    return { mismatched: Array.isArray(payload.mismatched) ? payload.mismatched : [] };
  },

  async compatibility(input?: { directory?: string | null }): Promise<WorkspaceCompatibilityResult> {
    const response = await runtimeFetch('/api/workspaces/compatibility', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      query: input?.directory ? { directory: input.directory } : {},
    });
    const payload = await readJson<WorkspaceCompatibilityResult | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw new Error('error' in payload && payload.error ? payload.error : 'Failed to inspect workspace compatibility');
    return payload as WorkspaceCompatibilityResult;
  },

  async updateSettings(input): Promise<WorkspaceConfigureResult> {
    const response = await runtimeFetch('/api/workspaces/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...proofHeaders(input.reauthProof, input.reauthNonce) },
      body: JSON.stringify({ changes: input.changes, activate: input.activate === true }),
    });
    const payload = await readJson<WorkspaceConfigureResult | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw new Error('error' in payload && payload.error ? payload.error : 'Failed to configure secure workspaces');
    return payload as WorkspaceConfigureResult;
  },

  async create(input) {
    const payload = { type: input.type, directory: input.directory?.trim() || '', extra: input.extra ?? null };
    const response = await runtimeFetch('/api/workspaces/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...proofHeaders(input.reauthProof, input.reauthNonce) },
      body: JSON.stringify(payload),
    });
    const result = await readJson<{ id?: string; type?: string; name?: string; directory?: string | null; status?: 'connected' | 'connecting'; provisional?: boolean; retryable?: boolean; diagnostics?: string[]; error?: string }>(response, { error: response.statusText });
    if (!response.ok || !result.id) throw new Error(result.error || 'Failed to create workspace');
    return { ...result, status: result.status ?? 'connecting', provisional: result.provisional !== false, retryable: result.retryable !== false, diagnostics: result.diagnostics ?? [] } as { id: string; type: string; name: string; directory?: string | null; status: 'connected' | 'connecting'; provisional: boolean; retryable: boolean; diagnostics: string[] };
  },

  async cleanup(input) {
    const response = await runtimeFetch(`/api/workspaces/${encodeURIComponent(input.id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...proofHeaders(input.reauthProof, input.reauthNonce) },
      body: JSON.stringify({ directory: input.directory?.trim() || '' }),
    });
    const result = await readJson<{ cleaned?: boolean; diagnostics?: string[]; remainingResources?: string[]; retainedResources?: string[]; retryable?: boolean; error?: string; code?: string }>(response, { error: response.statusText });
    if (!response.ok) return { ...result, cleaned: false, diagnostics: result.diagnostics ?? [], remainingResources: result.remainingResources ?? [], error: result.error || response.statusText };
    return { ...result, diagnostics: result.diagnostics ?? [] };
  },

  async reconcileWorkspace(input) {
    const payload = { id: input.id, directory: input.directory?.trim() || '' };
    const response = await runtimeFetch(`/api/workspaces/${encodeURIComponent(input.id)}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...proofHeaders(input.reauthProof, input.reauthNonce) },
      body: JSON.stringify({ directory: payload.directory }),
    });
    const result = await readJson<{ reconciled?: boolean; status?: string; diagnostics?: string[]; error?: string }>(response, { error: response.statusText });
    if (!response.ok) return { ...result, reconciled: false, diagnostics: result.diagnostics ?? [], error: result.error || response.statusText };
    return { ...result, diagnostics: result.diagnostics ?? [] };
  },

  async downloadArtifact(input): Promise<WorkspaceArtifactDownload> {
    const response = await runtimeFetch(`/api/workspaces/exports/${encodeURIComponent(input.exportID)}/download`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      query: { workspaceID: input.workspaceID },
    });
    if (!response.ok) {
      const payload = await readJson<{ error?: string }>(response, { error: response.statusText });
      throw new Error(payload.error || 'Failed to download workspace export');
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? `workspace-export-${input.exportID}.json`;
    return { blob: await response.blob(), fileName };
  },

  async discardArtifact(input) {
    const response = await runtimeFetch(`/api/workspaces/exports/${encodeURIComponent(input.exportID)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ workspaceID: input.workspaceID }),
    });
    const result = await readJson<{ discarded?: boolean; error?: string }>(response, { error: response.statusText });
    if (!response.ok || result.discarded !== true) throw new Error(result.error || 'Failed to discard workspace export');
    return { discarded: true };
  },

  async exportWorkspace(input): Promise<WorkspaceExportResult> {
    const response = await runtimeFetch(`/api/workspaces/${encodeURIComponent(input.id)}/export`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...proofHeaders(input.reauthProof, input.reauthNonce) },
      query: input.directory ? { directory: input.directory } : {},
    });
    const payload = await readJson<WorkspaceExportResult | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw new Error('error' in payload && payload.error ? payload.error : 'Failed to export workspace changes');
    return payload as WorkspaceExportResult;
  },

  async applyExport(input): Promise<WorkspaceApplyResult> {
    const route = `/api/workspaces/exports/${encodeURIComponent(input.exportID)}/apply`;
    const response = await runtimeFetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...proofHeaders(input.reauthProof, input.reauthNonce) },
      body: JSON.stringify({
        directory: input.directory,
        exportID: input.exportID,
        selections: input.selections,
        workspaceID: input.workspaceID,
        checkOnly: input.checkOnly !== false,
      }),
    });
    const payload = await readJson<WorkspaceApplyResult>(response, {
      applied: false,
      checkOnly: input.checkOnly !== false,
      error: response.statusText,
    });
    if (!response.ok) return { ...payload, applied: false, error: payload.error || response.statusText };
    return payload;
  },

  async startSession(input): Promise<WorkspaceSessionStartResult> {
    const payload = { operationID: input.operationID, directory: input.directory.trim(), title: input.title?.trim() ?? '' };
    const response = await runtimeFetch('/api/workspaces/sessions/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...proofHeaders(input.reauthProof, input.reauthNonce) },
      body: JSON.stringify(payload),
    });
    const result = await readJson<WorkspaceSessionStartResult | WorkspaceSessionStartError>(response, {
      code: 'WORKSPACE_SESSION_START_FAILED', message: response.statusText, retryable: false, operationID: payload.operationID,
    });
    if (!response.ok) throw Object.assign(new Error('message' in result ? result.message : response.statusText), { ...result, status: response.status });
    return result as WorkspaceSessionStartResult;
  },

  async createHandoffDraft(input): Promise<WorkspaceHandoffOperation> {
    const response = await runtimeFetch('/api/workspaces/handoffs/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await readJson<WorkspaceHandoffOperation | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw Object.assign(new Error('error' in payload && payload.error ? payload.error : 'Failed to create handoff draft'), payload);
    return payload as WorkspaceHandoffOperation;
  },

  async commitHandoff(input): Promise<WorkspaceHandoffOperation> {
    const response = await runtimeFetch(`/api/workspaces/handoffs/${encodeURIComponent(input.operationID)}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await readJson<WorkspaceHandoffOperation | { error?: string; staleDraft?: boolean; cleanupRequired?: boolean }>(response, { error: response.statusText });
    if (!response.ok) throw Object.assign(new Error('error' in payload && payload.error ? payload.error : 'Failed to commit handoff'), payload);
    return payload as WorkspaceHandoffOperation;
  },

  async inspectHandoff(operationID): Promise<WorkspaceHandoffOperation> {
    const response = await runtimeFetch(`/api/workspaces/handoffs/${encodeURIComponent(operationID)}`, { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await readJson<WorkspaceHandoffOperation | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw new Error('error' in payload && payload.error ? payload.error : 'Failed to inspect handoff');
    return payload as WorkspaceHandoffOperation;
  },

  async cleanupHandoffTarget(operationID): Promise<WorkspaceHandoffOperation> {
    const response = await runtimeFetch(`/api/workspaces/handoffs/${encodeURIComponent(operationID)}/target`, { method: 'DELETE', headers: { Accept: 'application/json' } });
    const payload = await readJson<WorkspaceHandoffOperation | { error?: string }>(response, { error: response.statusText });
    if (!response.ok) throw new Error('error' in payload && payload.error ? payload.error : 'Failed to clean handoff target');
    return payload as WorkspaceHandoffOperation;
  },
});
