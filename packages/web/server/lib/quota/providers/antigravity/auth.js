/**
 * Antigravity Provider - Auth
 *
 * Authentication resolution logic for Antigravity quota provider.
 * @module quota/providers/antigravity/auth
 */

import {
  ANTIGRAVITY_ACCOUNTS_PATHS,
  readJsonFile,
  asNonEmptyString,
  toNumber,
  getAuthEntry,
  normalizeAuthEntry,
  asObject
} from '../../utils/index.js';
import { parseGoogleRefreshToken } from '../google/transforms.js';

export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export const resolveAntigravityAuth = () => {
  for (const filePath of ANTIGRAVITY_ACCOUNTS_PATHS) {
    const data = readJsonFile(filePath);
    const accounts = data?.accounts;
    if (Array.isArray(accounts) && accounts.length > 0) {
      const parsedIndex = toNumber(data.activeIndex);
      const index = parsedIndex !== null ? parsedIndex : 0;
      const account = accounts[index] ?? accounts[0];
      if (account?.refreshToken) {
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
export const resolveAntigravityStoreAuth = (auth) => {
  const authObject = asObject(auth);
  if (!authObject) {
    return null;
  }

  const entry = normalizeAuthEntry(getAuthEntry(authObject, ['google', 'google.oauth']));
  const entryObject = asObject(entry);
  if (!entryObject) {
    return null;
  }

  const oauthObject = asObject(entryObject.oauth) ?? entryObject;
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

export const isConfigured = (auth) => resolveAntigravityAuth() !== null || resolveAntigravityStoreAuth(auth) !== null;
