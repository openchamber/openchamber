import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeFetch = vi.fn();
vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({ runtimeFetch }));
vi.mock('@openchamber/ui/lib/passkeys', () => ({ reauthenticateWithPasskey: vi.fn() }));

describe('web workspace security API', () => {
  beforeEach(() => runtimeFetch.mockReset());

  it('uses structured export and apply routes without browser artifact content', async () => {
    runtimeFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        exportID: 'export-1',
        provider: 'docker',
        expiresAt: '2030-01-01T00:00:00.000Z',
        review: { totalFiles: 1, files: [] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ applied: false, checkOnly: true, files: ['file-1'] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { createWebWorkspaceSecurityAPI } = await import('./workspaces');
    const api = createWebWorkspaceSecurityAPI();

    await api.exportWorkspace({ id: 'workspace-1', directory: '/project' });
    const selections = [{ fileID: 'file-1', hunkIDs: ['hunk-1'] }];
    await api.applyExport({ directory: '/project', exportID: 'export-1', workspaceID: 'workspace-1', selections, checkOnly: true });

    expect(runtimeFetch).toHaveBeenNthCalledWith(1, '/api/workspaces/workspace-1/export', expect.objectContaining({ method: 'GET', query: { directory: '/project' } }));
    expect(runtimeFetch).toHaveBeenNthCalledWith(2, '/api/workspaces/exports/export-1/apply', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ directory: '/project', exportID: 'export-1', selections, workspaceID: 'workspace-1', checkOnly: true }),
    }));
  });

  it('uses explicit handoff routes and preserves the exact reviewed binding', async () => {
    const operation = { operationID: 'operation-1', state: 'drafted', binding: { projectID: 'project-1', directory: '/project', sourceSessionID: 'source-1', sourceWorkspaceID: null, targetWorkspaceID: 'workspace-1' }, targetSessionID: null, cleanupRequired: false, draft: { id: 'draft-1', revision: 1, hash: 'hash', text: 'context', boundary: { through: 'message-1', hash: 'boundary', count: 1 }, omissions: [], warningCodes: ['not-exact-history', 'excluded-content', 'file-changes-excluded'] } };
    runtimeFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(operation), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...operation, state: 'completed', targetSessionID: 'target-1', draft: undefined }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { createWebWorkspaceSecurityAPI } = await import('./workspaces');
    const api = createWebWorkspaceSecurityAPI();
    const draft = await api.createHandoffDraft(operation.binding);
    const commit = { ...operation.binding, operationID: operation.operationID, draftID: operation.draft.id, draftRevision: 1, draftHash: 'hash', text: 'edited context' };
    await api.commitHandoff(commit);

    expect(draft).toEqual(operation);
    expect(runtimeFetch).toHaveBeenNthCalledWith(1, '/api/workspaces/handoffs/draft', expect.objectContaining({ method: 'POST', body: JSON.stringify(operation.binding) }));
    expect(runtimeFetch).toHaveBeenNthCalledWith(2, '/api/workspaces/handoffs/operation-1/commit', expect.objectContaining({ method: 'POST', body: JSON.stringify(commit) }));
  });
});
