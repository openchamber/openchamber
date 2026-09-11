/**
 * Extension-host bootstrap config injected into the VS Code webview HTML
 * before any bundled module evaluates. Prefer this over RuntimeAPIs for
 * early VS Code detection during store module initialization.
 */
export interface VSCodeBootstrapConfig {
  workspaceFolder?: unknown;
  workspaceFolders?: unknown;
}

export const getVSCodeBootstrapConfig = (): VSCodeBootstrapConfig | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return (window as unknown as { __VSCODE_CONFIG__?: VSCodeBootstrapConfig }).__VSCODE_CONFIG__ ?? null;
};

export const isVSCodeBootstrapPresent = (
  bootstrapConfig: VSCodeBootstrapConfig | null = getVSCodeBootstrapConfig(),
): boolean => Boolean(bootstrapConfig);
