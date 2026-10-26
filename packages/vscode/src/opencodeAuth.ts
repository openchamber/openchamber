import { openCodeCredentialSource as fromConnection, type CredentialSource } from '../../web/server/lib/opencode/auth.js';

/**
 * Provider credentials for the extension host. The reader, its projection to
 * the legacy `auth.json` shape and its failure rules are the web server's
 * (`packages/web/server/lib/opencode/auth.js`); only the connection differs.
 */
export {
  configureOpenCodeCredentials,
  getProviderAuth,
  readOpenCodeCredentials,
} from '../../web/server/lib/opencode/auth.js';

/** The OpenCode this extension manages or connects to, read per call because a restart moves it. */
export const openCodeCredentialSource = (manager: {
  getApiUrl(): string | null;
  getOpenCodeAuthHeaders(): Record<string, string>;
  getManagedLaunchEnvironment(): NodeJS.ProcessEnv | null;
}): CredentialSource => {
  const connected = (): CredentialSource => {
    const apiUrl = manager.getApiUrl();
    if (!apiUrl) throw new Error('OpenCode API URL is not available');
    return fromConnection({
      buildOpenCodeUrl: () => apiUrl,
      getOpenCodeAuthHeaders: () => manager.getOpenCodeAuthHeaders(),
      getLaunchEnvironment: () => manager.getManagedLaunchEnvironment(),
    });
  };
  return {
    list: async () => connected().list(),
    listEnvironmentKeys: async () => connected().listEnvironmentKeys?.() ?? {},
  };
};
