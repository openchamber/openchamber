import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createVSCodeWorkspaceSecurityAPI } from './workspaces';

describe('VS Code Secure Workspaces contract', () => {
  test('returns a stable explicit unsupported result', async () => {
    const api = createVSCodeWorkspaceSecurityAPI();

    assert.deepEqual(await api.validateProvider({ provider: 'docker' }), {
      available: false,
      error: 'Secure Workspaces are not supported in the VS Code runtime.',
    });
    assert.deepEqual(await api.compatibility(), {
      configured: false,
      active: false,
      supported: false,
      adapterKinds: [],
      status: 'not-configured',
      error: 'Secure Workspaces are not supported in the VS Code runtime.',
    });
    assert.deepEqual(await api.updateSettings({ changes: {} }), {
      configured: false,
      enabled: false,
      active: false,
      compatibility: {
        configured: false,
        active: false,
        supported: false,
        adapterKinds: [],
        status: 'not-configured',
        error: 'Secure Workspaces are not supported in the VS Code runtime.',
      },
    });
  });

  test('never exposes privileged export or apply behavior', async () => {
    const api = createVSCodeWorkspaceSecurityAPI();

    await assert.rejects(api.exportWorkspace({ id: 'workspace-a' }), /not supported/);
    await assert.rejects(api.reconcileWorkspace({ id: 'workspace-a' }), /not supported/);
    await assert.rejects(api.downloadArtifact({ exportID: 'export', workspaceID: 'workspace-a' }), /not supported/);
    await assert.rejects(api.discardArtifact({ exportID: 'export', workspaceID: 'workspace-a' }), /not supported/);
    await assert.rejects(api.createHandoffDraft({ projectID: 'project-a', directory: '/project', sourceSessionID: 'session-a', sourceWorkspaceID: null, targetWorkspaceID: 'workspace-a' }), /not supported/);
    await assert.rejects(api.inspectHandoff('operation-a'), /not supported/);
    assert.deepEqual(await api.applyExport({ directory: '/project', exportID: 'export', workspaceID: 'workspace-a', selections: [], checkOnly: false }), {
      applied: false,
      checkOnly: false,
      error: 'Secure Workspaces are not supported in the VS Code runtime.',
    });
  });
});
