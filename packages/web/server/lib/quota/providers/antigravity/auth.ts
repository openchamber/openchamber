import { isObjectLike } from '../../../shared/object-guards.js';
import {
  ANTIGRAVITY_ACCOUNTS_PATHS,
  readJsonFile,
  asNonEmptyString,
  toNumber,
  getAuthEntry,
  normalizeAuthEntry
} from '../../utils/index.js';
import type { LegacyAuthFile } from '../../../opencode/auth.js';
import { parseGoogleRefreshToken } from '../google/transforms.js';

export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

interface AccountsFile {
  accounts?: unknown;
  activeIndex?: unknown;
}

interface Account {
  refreshToken?: unknown;
  projectId?: unknown;
  managedProjectId?: unknown;
  email?: unknown;
}

const isAccountsFile = (value: unknown): value is AccountsFile =>
  value !== null && typeof value === 'object';

const isAccount = (value: unknown): value is Account =>
  value !== null && typeof value === 'object';

export const resolveAntigravityAuth = () => {
  for (const filePath of ANTIGRAVITY_ACCOUNTS_PATHS) {
    const input: unknown = readJsonFile(filePath);
    const data = isAccountsFile(input) ? input : null;
    const accounts = data?.accounts;
    if (Array.isArray(accounts) && accounts.length > 0) {
      const parsedIndex = toNumber(data?.activeIndex);
      const index = parsedIndex !== null ? parsedIndex : 0;
      const account: unknown = accounts[index] ?? accounts[0];
      if (isAccount(account) && account.refreshToken) {
        const refreshParts = parseGoogleRefreshToken(account.refreshToken);
        return {
          sourceId: 'antigravity',
          sourceLabel: 'Antigravity',
          refreshToken: refreshParts.refreshToken,
          projectId: asNonEmptyString(account.projectId)
            ?? asNonEmptyString(account.managedProjectId)
            ?? refreshParts.projectId
            ?? refreshParts.managedProjectId,
          email: account.email
        };
      }
    }
  }

  return null;
};

/**
 * The Antigravity login OpenCode itself holds: the `google` integration's
 * OAuth credential in the credential store, written by the plugin's
 * `antigravity` auth method. Current plugin versions sign in through the
 * credential store and never write the legacy accounts file, so the store
 * is the live source and the file the fallback. A `google` entry that is
 * an API key carries no refresh token and resolves to null.
 */
interface StoreOAuthFields {
  oauth?: unknown;
  refresh?: unknown;
}
const hasStoreOAuthFields = (value: unknown): value is StoreOAuthFields => value !== null && typeof value === 'object';

export const resolveAntigravityStoreAuth = (auth: LegacyAuthFile | null | undefined) => {
  if (!auth || !isObjectLike(auth)) {
    return null;
  }

  const entry = normalizeAuthEntry(getAuthEntry(auth, ['google', 'google.oauth']));
  if (!hasStoreOAuthFields(entry)) {
    return null;
  }

  const oauthObject = hasStoreOAuthFields(entry.oauth) ? entry.oauth : entry;
  const refreshParts = parseGoogleRefreshToken(oauthObject.refresh);
  if (!refreshParts.refreshToken) {
    return null;
  }

  return {
    sourceId: 'antigravity',
    sourceLabel: 'Antigravity',
    refreshToken: refreshParts.refreshToken,
    projectId: refreshParts.projectId ?? refreshParts.managedProjectId
  };
};

export const isConfigured = (auth: LegacyAuthFile) => resolveAntigravityAuth() !== null || resolveAntigravityStoreAuth(auth) !== null;
