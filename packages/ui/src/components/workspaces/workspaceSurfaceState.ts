export type WorkspaceStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
export type WorkspaceRequiredCapability = 'workspace.admin' | 'host.apply';

export function workspaceProjectDirectory(
  projects: Array<{ id: string; path: string }>,
  activeProjectId: string | null,
  draft?: {
    open: boolean;
    selectedProjectId?: string | null;
    directoryOverride?: string | null;
    bootstrapPendingDirectory?: string | null;
  },
  currentSessionDirectory?: string | null,
): string {
  if (draft?.open) {
    const explicitDirectory = (draft.bootstrapPendingDirectory ?? draft.directoryOverride)?.trim();
    if (explicitDirectory) return explicitDirectory;
    if (!draft.selectedProjectId) return '';
    return projects.find((project) => project.id === draft.selectedProjectId)?.path.trim() ?? '';
  }
  const selectedDirectory = currentSessionDirectory?.trim().replace(/\/+$/, '') ?? '';
  if (selectedDirectory && projects.some((project) => {
    const projectPath = project.path.trim().replace(/\/+$/, '');
    return projectPath && (selectedDirectory === projectPath || selectedDirectory.startsWith(`${projectPath}/`));
  })) return selectedDirectory;
  if (!activeProjectId) return '';
  return projects.find((project) => project.id === activeProjectId)?.path.trim() ?? '';
}

export type WorkspaceSourceRefusal = 'home' | 'root';

/**
 * Whether a directory is one the workspace runtime will refuse to copy. A home directory
 * carries SSH keys, cloud credentials and shell history into the container, and a
 * filesystem root carries every account on the machine; neither is a project.
 *
 * The runtime refuses both regardless — this exists so nobody has to find out by pressing
 * a button and reading an error. It is the same fact, offered before the attempt.
 */
export function workspaceSourceRefusal(
  directory: string | null | undefined,
  homeDirectory: string | null | undefined,
  platform?: string | null,
): WorkspaceSourceRefusal | null {
  const candidate = comparablePath(directory, platform);
  if (!candidate) return null;
  // A drive on Windows ("C:"), a network share and the server it sits on, or "/" elsewhere.
  if (/^[a-zA-Z]:$/.test(candidate) || candidate === '/' || /^\/\/[^/]+(\/[^/]+)?$/.test(candidate)) return 'root';
  const home = comparablePath(homeDirectory, platform);
  if (home && candidate === home) return 'home';
  return null;
}

/** Path comparison only makes sense per platform: Windows and macOS ignore letter case. */
function comparablePath(value: string | null | undefined, platform?: string | null): string {
  if (typeof value !== 'string') return '';
  const slashed = value.trim().replace(/\\/g, '/');
  if (!slashed) return '';
  // A POSIX root is nothing but a separator, so stripping trailing ones would erase it.
  const normalized = /^\/+$/.test(slashed) ? '/' : slashed.replace(/\/+$/, '');
  if (!normalized) return '';
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

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
  // Merge instead of replacing: a workspace missing from one status payload keeps its
  // last known status rather than flipping to a permanent "Unknown status".
  return { ...current, ...Object.fromEntries(result.map((item) => [item.workspaceID, item.status])) };
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
