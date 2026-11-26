import { openCodeCredentialSource as fromConnection, type CredentialSource } from '../../web/server/lib/opencode/auth.js';
import { checkOpenCodeDirectoryTrust, openCodeTrust, type OpenCodeTrustGuard } from './opencodeTrust';

export {
  configureOpenCodeCredentials,
  getProviderAuth,
  readOpenCodeCredentials,
} from '../../web/server/lib/opencode/auth.js';

export const openCodeCredentialSource = (
  manager: {
    getApiUrl(): string | null;
    getOpenCodeAuthHeaders(): Record<string, string>;
    getManagedLaunchEnvironment(): NodeJS.ProcessEnv | null;
    getWorkingDirectory(): string;
  },
  trust: OpenCodeTrustGuard = openCodeTrust,
): CredentialSource => {
  const connected = (defaultDirectory: string | null = null): CredentialSource => {
    const apiUrl = manager.getApiUrl();
    if (!apiUrl) throw new Error('OpenCode API URL is not available');
    return fromConnection({
      buildOpenCodeUrl: () => apiUrl,
      getOpenCodeAuthHeaders: () => manager.getOpenCodeAuthHeaders(),
      getLaunchEnvironment: () => manager.getManagedLaunchEnvironment(),
      getDefaultDirectory: () => defaultDirectory,
    });
  };
  return {
    list: async () => connected().list(),
    listEnvironmentKeys: async () => {
      const directory = manager.getWorkingDirectory() || null;
      if (directory && await checkOpenCodeDirectoryTrust(directory, { path: '/api/integration', trust })) {
        return {};
      }
      return connected(directory).listEnvironmentKeys?.() ?? {};
    },
    readUsageLimits: async () => {
      const directory = manager.getWorkingDirectory() || null;
      if (directory && await checkOpenCodeDirectoryTrust(directory, { path: '/api/experimental/usage/limits', trust })) {
        return null;
      }
      return connected(directory).readUsageLimits?.() ?? null;
    },
  };
};
