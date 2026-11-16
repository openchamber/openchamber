import { openCodeCredentialSource as fromConnection, type CredentialSource } from '../../web/server/lib/opencode/auth.js';

export {
  configureOpenCodeCredentials,
  getProviderAuth,
  readOpenCodeCredentials,
} from '../../web/server/lib/opencode/auth.js';

export const openCodeCredentialSource = (manager: {
  getApiUrl(): string | null;
  getOpenCodeAuthHeaders(): Record<string, string>;
  getManagedLaunchEnvironment(): NodeJS.ProcessEnv | null;
  getWorkingDirectory(): string;
}): CredentialSource => {
  const connected = (): CredentialSource => {
    const apiUrl = manager.getApiUrl();
    if (!apiUrl) throw new Error('OpenCode API URL is not available');
    return fromConnection({
      buildOpenCodeUrl: () => apiUrl,
      getOpenCodeAuthHeaders: () => manager.getOpenCodeAuthHeaders(),
      getLaunchEnvironment: () => manager.getManagedLaunchEnvironment(),
      getDefaultDirectory: () => manager.getWorkingDirectory() || null,
    });
  };
  return {
    list: async () => connected().list(),
    listEnvironmentKeys: async () => connected().listEnvironmentKeys?.() ?? {},
    readUsageLimits: async () => connected().readUsageLimits?.() ?? null,
  };
};
