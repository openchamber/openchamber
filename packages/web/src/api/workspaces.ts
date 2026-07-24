import type {
  WorkspaceApplyResult,
  WorkspaceArtifactDownload,
  WorkspaceCompatibilityResult,
  WorkspaceConfigureResult,
  WorkspaceExportResult,
  WorkspaceProviderValidationInput,
  WorkspaceProviderValidationResult,
  WorkspaceSecurityAPI,
  WorkspaceHandoffOperation,
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
    const result = await readJson<{ cleaned?: boolean; diagnostics?: string[]; remainingResources?: string[]; retryable?: boolean; error?: string }>(response, { error: response.statusText });
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
