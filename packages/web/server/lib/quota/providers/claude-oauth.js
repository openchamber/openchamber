/**
 * Claude subscription OAuth access for Usage probes.
 * Refreshes expired tokens using the same public client as Claude Code /
 * OpenCode Anthropic auth, persists rotated credentials, and single-flights
 * concurrent renewals. Never logs token values.
 */

import { readAuthFile, writeAuthFile } from '../../opencode/auth.js';
import { getAuthEntry, normalizeAuthEntry } from '../utils/index.js';
import {
  readClaudeCliOAuthCredentials,
  writeClaudeCliOAuthCredentials,
} from './claude-cli-auth.js';

/** Public Claude Code / OpenCode Anthropic OAuth client id (not a secret). */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** OpenCode Anthropic plugin token endpoint. */
export const OPENCODE_CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

/** Claude Code CLI token endpoint. */
export const CLAUDE_CLI_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_SESSION_EXPIRED_ERROR = 'Session expired — please re-authenticate with Claude';

const AUTH_ALIASES = ['anthropic', 'claude'];
const REFRESH_BUFFER_MS = 60_000;

/** @type {Promise<ClaudeUsageAccess> | null} */
let claudeRefreshPromise = null;

/**
 * @typedef {{
 *   accessToken: string,
 *   refreshToken: string | null,
 *   expiresAt: number | null,
 *   source: 'env' | 'claude-cli' | 'opencode-auth',
 *   tokenUrl: string | null,
 *   authKey?: string,
 *   credentialsPath?: string,
 * }} ClaudeUsageCredential
 */

/**
 * @typedef {{
 *   accessToken: string,
 *   source: ClaudeUsageCredential['source'],
 *   canRefresh: boolean,
 * }} ClaudeUsageAccess
 */

/**
 * @param {number | null | undefined} expiresAt
 * @param {number} [now]
 * @returns {boolean}
 */
export function isClaudeAccessExpired(expiresAt, now = Date.now()) {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return false;
  }
  return expiresAt - REFRESH_BUFFER_MS <= now;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toExpiresMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

/**
 * @param {{
 *   refreshToken: string,
 *   tokenUrl: string,
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>}
 */
export async function refreshClaudeOAuthToken(input) {
  const fetchImpl = input.fetchImpl || fetch;
  const response = await fetchImpl(input.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'anthropic-beta': CLAUDE_OAUTH_BETA,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Claude token refresh failed: ${response.status}`);
  }

  const payload = await response.json();
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token.trim() : '';
  if (!accessToken) {
    throw new Error('Claude token refresh returned no access token');
  }

  const refreshToken = typeof payload?.refresh_token === 'string' && payload.refresh_token.trim()
    ? payload.refresh_token.trim()
    : input.refreshToken;
  const expiresIn = Number(payload?.expires_in);
  const expiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;

  return { accessToken, refreshToken, expiresAt };
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   homeDir?: string,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 *   readAuth?: () => Record<string, unknown>,
 * }} [options]
 * @returns {ClaudeUsageCredential | null}
 */
export function resolveClaudeUsageCredential(options = {}) {
  const cli = readClaudeCliOAuthCredentials({
    env: options.env,
    homeDir: options.homeDir,
    readFile: options.readFile,
    existsSync: options.existsSync,
  });

  if (cli?.accessToken) {
    if (cli.source === 'env') {
      return {
        accessToken: cli.accessToken,
        refreshToken: null,
        expiresAt: null,
        source: 'env',
        tokenUrl: null,
      };
    }

    return {
      accessToken: cli.accessToken,
      refreshToken: cli.refreshToken,
      expiresAt: cli.expiresAt,
      source: 'claude-cli',
      tokenUrl: CLAUDE_CLI_TOKEN_URL,
      credentialsPath: cli.credentialsPath || undefined,
    };
  }

  const readAuth = options.readAuth || readAuthFile;
  const auth = readAuth();
  for (const alias of AUTH_ALIASES) {
    const entry = normalizeAuthEntry(getAuthEntry(auth, [alias]));
    if (!entry || typeof entry !== 'object') continue;
    const access = typeof entry.access === 'string' && entry.access.trim()
      ? entry.access.trim()
      : typeof entry.token === 'string' && entry.token.trim()
        ? entry.token.trim()
        : null;
    if (!access) continue;

    const refresh = typeof entry.refresh === 'string' && entry.refresh.trim()
      ? entry.refresh.trim()
      : null;

    return {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: toExpiresMs(entry.expires),
      source: 'opencode-auth',
      tokenUrl: OPENCODE_CLAUDE_TOKEN_URL,
      authKey: alias,
    };
  }

  return null;
}

/**
 * @param {ClaudeUsageCredential} credential
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number }} tokens
 * @param {{
 *   writeAuth?: (auth: Record<string, unknown>) => void,
 *   readAuth?: () => Record<string, unknown>,
 *   writeCliCredentials?: typeof writeClaudeCliOAuthCredentials,
 * }} [options]
 */
function persistRefreshedCredential(credential, tokens, options = {}) {
  if (credential.source === 'claude-cli' && credential.credentialsPath) {
    const writeCli = options.writeCliCredentials || writeClaudeCliOAuthCredentials;
    writeCli(credential.credentialsPath, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
    return;
  }

  if (credential.source === 'opencode-auth' && credential.authKey) {
    const readAuth = options.readAuth || readAuthFile;
    const writeAuth = options.writeAuth || writeAuthFile;
    const auth = readAuth();
    const previous = normalizeAuthEntry(auth[credential.authKey]) || {};
    auth[credential.authKey] = {
      ...previous,
      type: 'oauth',
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: tokens.expiresAt,
    };
    writeAuth(auth);
  }
}

/**
 * Resolve a usable Claude subscription access token, refreshing when expired.
 *
 * @param {{
 *   forceRefresh?: boolean,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   homeDir?: string,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 *   readAuth?: () => Record<string, unknown>,
 *   writeAuth?: (auth: Record<string, unknown>) => void,
 *   writeCliCredentials?: typeof writeClaudeCliOAuthCredentials,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} [options]
 * @returns {Promise<ClaudeUsageAccess | null>}
 */
export async function ensureClaudeUsageAccessToken(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const now = options.now || Date.now;

  const load = () => resolveClaudeUsageCredential(options);

  const credential = load();
  if (!credential) return null;

  const canRefresh = Boolean(credential.refreshToken && credential.tokenUrl);
  const needsRefresh = forceRefresh || !credential.accessToken || isClaudeAccessExpired(credential.expiresAt, now());

  if (!needsRefresh) {
    return {
      accessToken: credential.accessToken,
      source: credential.source,
      canRefresh,
    };
  }

  if (!canRefresh || !credential.refreshToken || !credential.tokenUrl) {
    if (credential.accessToken && !forceRefresh) {
      return {
        accessToken: credential.accessToken,
        source: credential.source,
        canRefresh: false,
      };
    }
    return credential.accessToken
      ? {
          accessToken: credential.accessToken,
          source: credential.source,
          canRefresh: false,
        }
      : null;
  }

  if (!claudeRefreshPromise) {
    claudeRefreshPromise = (async () => {
      // Re-read under the lock in case another host already rotated tokens.
      const latest = load() || credential;
      if (
        !forceRefresh
        && latest.accessToken
        && !isClaudeAccessExpired(latest.expiresAt, now())
      ) {
        return {
          accessToken: latest.accessToken,
          source: latest.source,
          canRefresh: Boolean(latest.refreshToken && latest.tokenUrl),
        };
      }

      const refreshToken = latest.refreshToken || credential.refreshToken;
      const tokenUrl = latest.tokenUrl || credential.tokenUrl;
      if (!refreshToken || !tokenUrl) {
        throw new Error('Claude OAuth entry has no refresh token');
      }

      const tokens = await refreshClaudeOAuthToken({
        refreshToken,
        tokenUrl,
        fetchImpl: options.fetchImpl,
      });

      persistRefreshedCredential({ ...latest, refreshToken, tokenUrl }, tokens, options);

      return {
        accessToken: tokens.accessToken,
        source: latest.source,
        canRefresh: true,
      };
    })().finally(() => {
      claudeRefreshPromise = null;
    });
  }

  return claudeRefreshPromise;
}

/**
 * @param {string} accessToken
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export async function fetchClaudeUsagePayload(accessToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  return fetchImpl(CLAUDE_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': CLAUDE_OAUTH_BETA,
    },
    signal: AbortSignal.timeout(30_000),
  });
}

/** @internal test helper */
export function __resetClaudeRefreshLockForTests() {
  claudeRefreshPromise = null;
}
