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
  toNumber
} from '../../utils/index.js';
import { parseGoogleRefreshToken } from '../google/transforms.js';
import { resolveCliAuth } from './cli-credentials.js';

export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export const resolveAntigravityAuth = ({ accountPaths = ANTIGRAVITY_ACCOUNTS_PATHS, readAccounts = readJsonFile, readCliAuth = resolveCliAuth } = {}) => {
  for (const filePath of accountPaths) {
    const data = readAccounts(filePath);
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

  return readCliAuth();
};

export const isConfigured = () => resolveAntigravityAuth() !== null;
