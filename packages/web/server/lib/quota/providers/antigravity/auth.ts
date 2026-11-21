
import {
  ANTIGRAVITY_ACCOUNTS_PATHS,
  readJsonFile,
  asNonEmptyString,
  toNumber
} from '../../utils/index.js';
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

export const isConfigured = () => resolveAntigravityAuth() !== null;
