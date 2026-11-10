/**
 * Extension-host bootstrap config injected into the VS Code webview HTML
 * before any bundled module evaluates. Prefer this over RuntimeAPIs for
 * early VS Code detection during store module initialization.
 */
export interface VSCodeBootstrapConfig {
  workspaceFolder?: string;
  workspaceFolders?: unknown;
  panelType?: 'chat' | 'settings';
  /** "parallel" on the tab the "Run on several models" command opens. */
  initialComposer?: unknown;
}

export const getVSCodeBootstrapConfig = (): VSCodeBootstrapConfig | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return (window as unknown as { __VSCODE_CONFIG__?: VSCodeBootstrapConfig }).__VSCODE_CONFIG__ ?? null;
};

export const getVSCodeBootstrapWorkspaceFolder = (): string | null => {
  return getVSCodeBootstrapConfig()?.workspaceFolder?.trim() || null;
};

/** Workspace membership comes from the host, never the selected session's directory. */
export const isVSCodeWithoutWorkspace = (): boolean => {
  const config = getVSCodeBootstrapConfig();
  if (!config) return false;
  return Array.isArray(config.workspaceFolders)
    ? config.workspaceFolders.length === 0
    : !config.workspaceFolder?.trim();
};

export const isVSCodeBootstrapPresent = (
  bootstrapConfig: VSCodeBootstrapConfig | null = getVSCodeBootstrapConfig(),
): boolean => Boolean(bootstrapConfig);
