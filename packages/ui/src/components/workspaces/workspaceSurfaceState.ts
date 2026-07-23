export type WorkspaceStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
export type WorkspaceRequiredCapability = 'workspace.admin' | 'host.apply';

export function requiredCapabilityForWorkspaceOperation(operation: string): WorkspaceRequiredCapability | null {
  if (operation === 'host.apply') return 'host.apply';
  if (operation.startsWith('workspace.') && operation !== 'workspace.use' && operation !== 'workspace.read') return 'workspace.admin';
  return null;
}

export function requiredWorkspaceCapability(error: unknown): WorkspaceRequiredCapability | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message.includes('host.apply')) return 'host.apply';
  if (message.includes('workspace.admin')) return 'workspace.admin';
  return null;
}

export function workspaceStatusSnapshot(
  current: Record<string, WorkspaceStatus>,
  result: Array<{ workspaceID: string; status: WorkspaceStatus }> | null,
): Record<string, WorkspaceStatus> {
  if (result === null) return current;
  return Object.fromEntries(result.map((item) => [item.workspaceID, item.status]));
}

export function emptyWorkspaceScopeState() {
  return {
    workspaces: [] as Array<{ id: string; type: string; name: string; directory?: string | null }>,
    statuses: {} as Record<string, WorkspaceStatus>,
    selectedWorkspaceID: '',
    exportID: '',
    artifactReview: null,
  };
}
