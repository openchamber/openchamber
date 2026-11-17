export interface VSCodeBootstrapConfig {
  workspaceFolder?: string;
  workspaceFolders?: unknown;
  panelType?: 'chat' | 'settings';
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
