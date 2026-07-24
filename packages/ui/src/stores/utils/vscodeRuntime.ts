import type { RuntimeAPIs } from '@/lib/api/types';

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

export const isVSCodeRuntime = (
  runtimeApis: RuntimeAPIs | null,
  bootstrapConfig = getVSCodeBootstrapConfig(),
): boolean => Boolean(bootstrapConfig || runtimeApis?.runtime?.isVSCode);
