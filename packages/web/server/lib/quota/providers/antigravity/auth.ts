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
import { lookupSecretService } from './secret-service.js';

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

/**
 * The Antigravity login the agy CLI holds: a keyring credential (Secret
 * Service service `gemini`, username `antigravity`) whose token record the
 * opencode fork's antigravity-auth bridge reads in place — the live login
 * on machines signed in through the CLI, and the source the fleet's quota
 * gatherer reads the pool through. A surface that skips the keyring
 * reports such a machine "Not configured" while the fork reads the pool
 * fine (code#2490). The entry is read in place and never written back.
 */
interface KeyringCredential {
  token?: unknown;
}

interface KeyringToken {
  refresh_token?: unknown;
}

const isKeyringCredential = (value: unknown): value is KeyringCredential =>
  value !== null && typeof value === 'object';

const isKeyringToken = (value: unknown): value is KeyringToken =>
  value !== null && typeof value === 'object';

export const parseAntigravityKeyringCredential = (raw: string | undefined) => {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const token = isKeyringCredential(parsed) && isKeyringToken(parsed.token) ? parsed.token : null;
  // A whitespace-only refresh token is the unexpected-shape/absent case
  // the fork's bridge treats as no credential, not a token to present.
  const refreshToken = typeof token?.refresh_token === 'string' ? token.refresh_token.trim() : null;
  if (!refreshToken) {
    return null;
  }
  const refreshParts = parseGoogleRefreshToken(refreshToken);
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

interface AntigravityKeyringSources {
  lookupSecretService: (service: string, username: string) => Promise<string | undefined>;
}

const defaultKeyringSources: AntigravityKeyringSources = { lookupSecretService };
let keyringSources = defaultKeyringSources;

/** Replaces the keyring read (tests); `null` restores the real one. */
export const configureAntigravityKeyringSources = (next: Partial<AntigravityKeyringSources> | null) => {
  keyringSources = next ? { ...defaultKeyringSources, ...next } : defaultKeyringSources;
};

export const resolveAntigravityKeyringAuth = async () => {
  const raw = await keyringSources.lookupSecretService('gemini', 'antigravity').catch(() => undefined);
  return parseAntigravityKeyringCredential(raw);
};

export const isConfigured = async (auth: LegacyAuthFile) => resolveAntigravityAuth() !== null
  || resolveAntigravityStoreAuth(auth) !== null
  || (await resolveAntigravityKeyringAuth()) !== null;
